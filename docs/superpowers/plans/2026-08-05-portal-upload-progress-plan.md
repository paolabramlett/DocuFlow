# Portal Upload Progress + Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Client Portal's document upload a real, byte-accurate progress bar and a genuine mid-transfer cancel, by replacing the single Server Action that proxies the whole file through the Next.js server with a prepare → direct-browser-XHR-upload → finalize flow.

**Architecture:** A new `document_upload_sessions` table tracks each upload attempt through an explicit state machine (`pending → finalizing → completed`, plus `cancelled`/`expired`). Three new RPCs (`claim_upload_session_for_finalize`, `finalize_document_upload`, `cancel_upload_session`) own every state transition atomically. The browser uploads directly to Supabase Storage via a hand-rolled `XMLHttpRequest` PUT (for real `onprogress`/`abort()`, which `fetch()` cannot provide), never routing file bytes through the Next.js server. The old proxy path is retired only after the new flow is validated end-to-end, as its own separate, revertible commit.

**Tech Stack:** Next.js 16 Server Actions, `XMLHttpRequest` (browser), Supabase Storage signed upload URLs, `plpgsql` RPCs, `pg_cron` + a Deno Edge Function (mirroring this project's existing `send-reminders` pattern), Vitest (isolation/integration/component tests).

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-05-portal-upload-progress-design.md` — read it once before Task 1; every task below implements one section of it. Do not reopen decisions already locked there: no `tmp/` prefix (upload straight to the final deterministic path), no lease token/nonce (the live-status check under `FOR UPDATE` already proves the race is closed — see the design's own worked trace), checksum out of scope, `content_type` comparison is metadata consistency, never content validation.
- Every RPC exception uses `raise exception using errcode = 'P0001', message = 'stable_snake_case_code'` — a fixed literal, never `%`-interpolated.
- Authorization is always a plain, non-locking SELECT before any `FOR UPDATE` row lock, in every RPC.
- Copy shown to users is Spanish (Mexico).
- Server Actions never call `redirect()`; they return `ActionResult<T>`.
- `ALLOWED_CONTENT_TYPES`/`MAX_DOCUMENT_BYTES` (`src/features/documents/schemas.ts`) and `documentObjectPath`'s path shape (`src/lib/storage/paths.ts`) are unchanged and reused as-is.
- Before running any command that writes to the database (`npm run db:reset`, `npx vitest run`, `npm run db:seed`), confirm `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL` is `http://127.0.0.1:...` — never a production URL.
- Run `npm run typecheck && npm run lint` after every task that touches `.ts`/`.tsx` files, before committing.
- Working directly on `main`, no worktree, matching this project's established pattern. Stage `git add` narrowly (only the files each task names) — never `git add -A`. This repo has one known, pre-existing, unrelated modified file (`public/img/LogoMark-white.png`) that must NOT be in any commit.

---

## Task 1: Schema migration — `document_upload_sessions`

**Files:**
- Create: `supabase/migrations/20260805170000_document_upload_sessions.sql`
- Test: `tests/isolation/document-upload-sessions.test.ts` (new file, started here)

**Interfaces:**
- Produces: `document_upload_sessions` table with columns `id, organization_id, case_id, requirement_id, participant_id, bucket, storage_path, original_file_name, declared_content_type, declared_size_bytes, signed_url_expires_at, reserved_document_id, completed_document_id, status, claimed_at, created_at, expires_at, completed_at` — every later task reads/writes these exact names.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260805170000_document_upload_sessions.sql
--
-- Schema for the Portal upload progress + cancel feature. See
-- docs/superpowers/specs/2026-08-05-portal-upload-progress-design.md for the full design. This
-- file only adds the table/RLS/constraints; the three RPCs and the cleanup functions are their
-- own, later-numbered migrations (dependency order, not just style).

create table public.document_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  requirement_id uuid not null,
  participant_id uuid not null,
  bucket text not null default 'case-documents',
  storage_path text not null unique,
  original_file_name text not null check (length(btrim(original_file_name)) between 1 and 500),
  declared_content_type text not null,
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  -- Recorded at prepare time as now() + 2 hours — the empirically-confirmed default TTL of the
  -- signed upload URL itself (see design spec §3). Not read by any code path yet — purely for
  -- future observability, distinguishing our own session expiry from the signed URL's own.
  signed_url_expires_at timestamptz not null,
  -- The eventual documents.id, chosen before any documents row exists. A reservation, not a
  -- reference — cannot carry a foreign key yet.
  reserved_document_id uuid not null,
  -- Filled only by finalize_document_upload, on success. Always equal to reserved_document_id
  -- when non-null — enforced below, not just a convention.
  completed_document_id uuid references public.documents (id),
  status text not null default 'pending'
    check (status in ('pending', 'finalizing', 'completed', 'cancelled', 'expired')),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,

  constraint document_upload_sessions_completed_matches_reserved
    check (completed_document_id is null or completed_document_id = reserved_document_id),
  constraint document_upload_sessions_claimed_only_when_finalizing
    check ((status = 'finalizing') = (claimed_at is not null)),
  constraint document_upload_sessions_completed_only_when_completed
    check ((status = 'completed') = (completed_document_id is not null and completed_at is not null))
);

create index document_upload_sessions_cleanup_idx
  on public.document_upload_sessions (status, expires_at)
  where status in ('pending', 'finalizing');

create index document_upload_sessions_requirement_idx
  on public.document_upload_sessions (requirement_id);

alter table public.document_upload_sessions enable row level security;

-- A Participant may see and create their own sessions (scoped by an active 'upload' grant,
-- mirroring requirements' own grant-scoped policy shape). No update/delete policy for any client
-- role — every state transition happens through the RPCs in later tasks (security invoker, so
-- they rely on this same SELECT policy for their own authorization read, then FOR UPDATE).
create policy document_upload_sessions_select_own
  on public.document_upload_sessions for select
  to authenticated
  using (participant_id in (select app.granted_participant_ids('upload')));

create policy document_upload_sessions_insert_own
  on public.document_upload_sessions for insert
  to authenticated
  with check (participant_id in (select app.granted_participant_ids('upload')));

comment on table public.document_upload_sessions is
  'Tracks a Portal document upload attempt through prepare -> direct browser upload -> finalize.
   State machine: pending -> finalizing -> completed, or pending -> cancelled, or
   pending/finalizing -> expired. See design spec section 4 for the full claim/finalize race
   analysis and section 9 for why terminal rows are retained (not deleted) for 7-30 days.';
```

- [ ] **Step 2: Apply the migration locally**

Run: `npm run db:reset`
Expected: migration applies with no errors.

- [ ] **Step 3: Regenerate types**

Run: `npm run db:types`
Expected: `src/types/database.ts` gains a `document_upload_sessions` table entry with every column above.

- [ ] **Step 4: Write the failing isolation test (schema shape only — no RPCs exist yet)**

```typescript
// tests/isolation/document-upload-sessions.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';
import { buildOrganizationWorld } from '../helpers/fixtures';

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe('document_upload_sessions: schema', () => {
  it('rejects an invalid status value', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions Schema',
      industry: 'notary',
      clientEmail: `upload-sessions-schema-${randomUUID()}@example.test`,
    });
    const admin = adminClient();

    const { error } = await admin.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0],
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: randomUUID(),
      expires_at: futureIso(30),
      status: 'bogus',
    });

    expect(error).not.toBeNull();
  });

  it('rejects completed_document_id when it does not match reserved_document_id', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions Mismatch',
      industry: 'notary',
      clientEmail: `upload-sessions-mismatch-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    const reservedId = randomUUID();

    const { error } = await admin.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0],
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: reservedId,
      completed_document_id: randomUUID(), // deliberately different
      expires_at: futureIso(30),
    });

    expect(error?.message).toContain('document_upload_sessions_completed_matches_reserved');
  });

  it('rejects claimed_at set without status = finalizing, and vice versa', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions ClaimedAt',
      industry: 'notary',
      clientEmail: `upload-sessions-claimedat-${randomUUID()}@example.test`,
    });
    const admin = adminClient();

    const { error } = await admin.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0],
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: randomUUID(),
      expires_at: futureIso(30),
      status: 'pending',
      claimed_at: new Date().toISOString(), // pending must never carry a claimed_at
    });

    expect(error?.message).toContain('document_upload_sessions_claimed_only_when_finalizing');
  });

  it('a Participant can see only their own sessions', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions Isolation',
      industry: 'notary',
      clientEmail: `upload-sessions-iso-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    const { data: session } = await admin
      .from('document_upload_sessions')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: world.requirementIds[0],
        participant_id: world.participantId,
        storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
        original_file_name: 'test.pdf',
        declared_content_type: 'application/pdf',
        declared_size_bytes: 1000,
        signed_url_expires_at: futureIso(120),
        reserved_document_id: randomUUID(),
        expires_at: futureIso(30),
      })
      .select('id')
      .single();

    const other = await createOrganizationWithOwner('Notaría Upload Sessions Isolation Other', 'notary');
    const { data: visibleToOther } = await other.owner.client
      .from('document_upload_sessions')
      .select('id')
      .eq('id', session!.id);
    expect(visibleToOther).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/isolation/document-upload-sessions.test.ts`
Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260805170000_document_upload_sessions.sql src/types/database.ts tests/isolation/document-upload-sessions.test.ts
git commit -m "Add document_upload_sessions schema: reserved/completed document_id split, state machine constraints"
```

---

## Task 2: `claim_upload_session_for_finalize` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260805170100_claim_upload_session_rpc.sql`
- Modify: `tests/isolation/document-upload-sessions.test.ts`

**Interfaces:**
- Consumes: `document_upload_sessions` (Task 1).
- Produces: `public.claim_upload_session_for_finalize(p_session_id uuid) returns table (already_completed boolean, completed_document_id uuid)` — Task 8's Server Action calls this.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260805170100_claim_upload_session_rpc.sql

create or replace function public.claim_upload_session_for_finalize(p_session_id uuid)
returns table (already_completed boolean, completed_document_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_session public.document_upload_sessions;
  v_lease_minutes constant integer := 5;
begin
  -- Authorization: this table's own SELECT policy (document_upload_sessions_select_own, Task 1)
  -- already scopes every read to `participant_id in (select app.granted_participant_ids('upload'))`
  -- — a caller with no active 'upload' grant on this session gets ZERO rows from this plain
  -- SELECT, not an error, so v_org_id is null for BOTH "this session genuinely does not exist"
  -- and "it exists but isn't yours." There is no separate not_authorized branch to add here: RLS
  -- already collapses both into the same outcome, matching this codebase's own established
  -- precedent (getPortalCase's doc comment: "Returns null if the Participant row itself is not
  -- visible — the grant is not active, or belongs to someone else; both look identical, by
  -- design"). Unlike the Staff-side RPCs (close_case, advance_case_stage, etc.), which check
  -- organization membership as a SEPARATE condition from row visibility, a Participant's access to
  -- their own session has no such second axis — RLS's participant_id scoping IS the entire
  -- authorization model here.
  select organization_id into v_org_id from public.document_upload_sessions where id = p_session_id;
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

  select * into v_session from public.document_upload_sessions where id = p_session_id for update;

  -- Deliberately the FIRST branch: a retry of an already-finished session returns its document id
  -- immediately, before anything else runs — including before finalizeUploadAction ever calls
  -- storage.info(). See design spec section 4.
  if v_session.status = 'completed' then
    return query select true, v_session.completed_document_id;
    return;
  end if;

  if v_session.status = 'finalizing' then
    if v_session.claimed_at > now() - make_interval(mins => v_lease_minutes) then
      raise exception using errcode = 'P0001', message = 'upload_finalize_in_progress';
    end if;
    -- Lease is stale: fall through and reclaim it as if it were 'pending'.
  elsif v_session.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'upload_session_cancelled';
  elsif v_session.status = 'expired' then
    raise exception using errcode = 'P0001', message = 'upload_session_expired';
  elsif v_session.status <> 'pending' then
    -- Defensive: every other branch is covered above; this should be unreachable.
    raise exception using errcode = 'P0001', message = 'upload_session_not_pending';
  end if;

  if v_session.expires_at <= now() then
    update public.document_upload_sessions set status = 'expired' where id = p_session_id;
    raise exception using errcode = 'P0001', message = 'upload_session_expired';
  end if;

  update public.document_upload_sessions
     set status = 'finalizing', claimed_at = now()
   where id = p_session_id;

  return query select false, null::uuid;
end;
$$;

revoke all on function public.claim_upload_session_for_finalize(uuid) from public;
grant execute on function public.claim_upload_session_for_finalize(uuid) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `claim_upload_session_for_finalize` appears in `src/types/database.ts`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/document-upload-sessions.test.ts`**

```typescript
// Add these imports at the top of the file: import { grantVerifiedAccess } from '../helpers/fixtures';

/** Inserts a session row directly (service role), returning its id and reserved_document_id. */
async function insertSession(
  world: Awaited<ReturnType<typeof buildOrganizationWorld>>,
  overrides: Partial<{
    status: string;
    claimedAt: string | null;
    expiresAt: string;
    completedDocumentId: string | null;
  }> = {},
) {
  const reservedDocumentId = randomUUID();
  const { data } = await adminClient()
    .from('document_upload_sessions')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0],
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${reservedDocumentId}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: reservedDocumentId,
      expires_at: overrides.expiresAt ?? futureIso(30),
      status: overrides.status ?? 'pending',
      claimed_at: overrides.claimedAt ?? null,
      completed_document_id: overrides.completedDocumentId ?? null,
      completed_at: overrides.completedDocumentId ? new Date().toISOString() : null,
    })
    .select('id, reserved_document_id')
    .single();
  return { sessionId: data!.id as string, reservedDocumentId: data!.reserved_document_id as string };
}

describe('claim_upload_session_for_finalize', () => {
  it('claims a pending session and marks it finalizing', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Pending',
      industry: 'notary',
      clientEmail: `claim-pending-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);

    const { data, error } = await granted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ already_completed: false, completed_document_id: null });

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status, claimed_at')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('finalizing');
    expect(after?.claimed_at).not.toBeNull();
  });

  it('short-circuits a completed session without any state change', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Completed',
      industry: 'notary',
      clientEmail: `claim-completed-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world, {
      status: 'completed',
      completedDocumentId: null, // set below once we know the id
    });
    // completed_document_id must equal reserved_document_id per the schema check constraint.
    await adminClient()
      .from('document_upload_sessions')
      .update({ completed_document_id: reservedDocumentId, completed_at: new Date().toISOString() })
      .eq('id', sessionId);

    const { data, error } = await granted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ already_completed: true, completed_document_id: reservedDocumentId });
  });

  it('refuses a session currently finalizing within its lease', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim InProgress',
      industry: 'notary',
      clientEmail: `claim-inprogress-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: new Date().toISOString() });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_finalize_in_progress');
  });

  it('reclaims a session finalizing past its lease', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Reclaim',
      industry: 'notary',
      clientEmail: `claim-reclaim-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString(); // 6 min ago, past the 5-min lease
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: staleClaimedAt });

    const { data, error } = await granted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });
    expect(error).toBeNull();
    expect(data?.[0]?.already_completed).toBe(false);

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('claimed_at')
      .eq('id', sessionId)
      .single();
    expect(Date.parse(after!.claimed_at!)).toBeGreaterThan(Date.parse(staleClaimedAt));
  });

  it('refuses a cancelled session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Cancelled',
      industry: 'notary',
      clientEmail: `claim-cancelled-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'cancelled' });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_cancelled');
  });

  it('refuses an expired session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Expired',
      industry: 'notary',
      clientEmail: `claim-expired-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'expired' });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_expired');
  });

  it('lazily expires a pending session whose expires_at already passed', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim LazyExpire',
      industry: 'notary',
      clientEmail: `claim-lazyexpire-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_expired');

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('expired');
  });

  it('a Client with no grant on this session cannot claim it — RLS hides the row entirely, so it is upload_session_not_found, not a separate not_authorized', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim TenantIsolation',
      industry: 'notary',
      clientEmail: `claim-tenant-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);
    const other = await createOrganizationWithOwner('Notaría Claim TenantOther', 'notary');

    const { error } = await other.owner.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_not_found');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/document-upload-sessions.test.ts`
Expected: all pass (8 tests in this describe block, 12 total in the file).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260805170100_claim_upload_session_rpc.sql src/types/database.ts tests/isolation/document-upload-sessions.test.ts
git commit -m "Add claim_upload_session_for_finalize RPC: completed short-circuit, lease-based reclaim"
```

---

## Task 3: `finalize_document_upload` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260805170200_finalize_document_upload_rpc.sql`
- Modify: `tests/isolation/document-upload-sessions.test.ts`

**Interfaces:**
- Consumes: `document_upload_sessions` (Task 1), `claim_upload_session_for_finalize` (Task 2, used in tests to set up a `finalizing` session).
- Produces: `public.finalize_document_upload(p_session_id uuid, p_verified_size_bytes bigint, p_verified_content_type text) returns uuid` (the new `documents.id`) — Task 8's Server Action calls this.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260805170200_finalize_document_upload_rpc.sql

create or replace function public.finalize_document_upload(
  p_session_id uuid,
  p_verified_size_bytes bigint,
  p_verified_content_type text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_session public.document_upload_sessions;
  v_requirement public.requirements;
  v_grant_active boolean;
  v_case_state text;
begin
  -- Authorization: RLS already scopes this SELECT to the caller's own participant_id (Task 2's
  -- claim RPC comment explains why there is no separate not_authorized branch here).
  select organization_id into v_org_id from public.document_upload_sessions where id = p_session_id;
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

  select * into v_session from public.document_upload_sessions where id = p_session_id for update;

  -- Live status check, not a trust-the-caller check: this is what makes a stale finalize attempt
  -- (reclaimed and re-finalized by someone else while this call was mid-flight) safe without a
  -- lease token. See design spec section 4's worked trace.
  if v_session.status <> 'finalizing' then
    raise exception using errcode = 'P0001', message = 'upload_session_not_finalizing';
  end if;

  -- Re-validate what could have changed during the upload's own wall-clock duration.
  select * into v_requirement from public.requirements where id = v_session.requirement_id for update;
  if v_requirement.status = 'satisfied' then
    raise exception using errcode = 'P0001', message = 'requirement_already_satisfied';
  end if;

  select
    (g.verified_at is not null and g.revoked_at is null and g.expires_at is not null
     and g.expires_at > now() and g.permission = 'upload')
    into v_grant_active
  from public.case_access_grants g
  where g.participant_id = v_session.participant_id
  order by g.created_at desc
  limit 1;
  if v_grant_active is not true then
    raise exception using errcode = 'P0001', message = 'grant_no_longer_active';
  end if;

  select state into v_case_state from public.cases where id = v_session.case_id;
  if v_case_state <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

  -- Replicates registerDocument's insert + audit shape directly in SQL, since this must run
  -- inside the same transaction/lock as the session's own completion. registerDocument (TS)
  -- itself is untouched and keeps serving whatever else calls it.
  insert into public.documents (
    id, organization_id, case_id, requirement_id, storage_path,
    file_name, content_type, size_bytes, uploaded_by_auth_user_id
  ) values (
    v_session.reserved_document_id, v_org_id, v_session.case_id, v_session.requirement_id,
    v_session.storage_path, v_session.original_file_name, p_verified_content_type,
    p_verified_size_bytes, (select auth.uid())
  );

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_org_id, v_session.case_id, 'document.uploaded', 'document', v_session.reserved_document_id,
    'client', (select auth.uid()),
    jsonb_build_object('fileName', v_session.original_file_name, 'contentType', p_verified_content_type, 'sizeBytes', p_verified_size_bytes)
  );

  update public.document_upload_sessions
     set status = 'completed', completed_at = now(), completed_document_id = v_session.reserved_document_id
   where id = p_session_id;

  return v_session.reserved_document_id;
end;
$$;

revoke all on function public.finalize_document_upload(uuid, bigint, text) from public;
grant execute on function public.finalize_document_upload(uuid, bigint, text) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `finalize_document_upload` appears in `src/types/database.ts`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/document-upload-sessions.test.ts`**

```typescript
describe('finalize_document_upload', () => {
  it('registers the document using the VERIFIED size/content-type, not the declared ones', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Verified',
      industry: 'notary',
      clientEmail: `finalize-verified-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const { data: documentId, error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 4242, // deliberately different from insertSession's declared 1000
      p_verified_content_type: 'image/png', // deliberately different from declared 'application/pdf'
    });

    expect(error).toBeNull();
    expect(documentId).toBe(reservedDocumentId);

    const { data: doc } = await adminClient()
      .from('documents')
      .select('size_bytes, content_type')
      .eq('id', reservedDocumentId)
      .single();
    expect(doc).toMatchObject({ size_bytes: 4242, content_type: 'image/png' });

    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('status, completed_document_id, completed_at')
      .eq('id', sessionId)
      .single();
    expect(session?.status).toBe('completed');
    expect(session?.completed_document_id).toBe(reservedDocumentId);
    expect(session?.completed_at).not.toBeNull();
  });

  it('refuses a session that is not currently finalizing', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize NotFinalizing',
      industry: 'notary',
      clientEmail: `finalize-notfinalizing-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world); // still pending, never claimed

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('upload_session_not_finalizing');
  });

  it('refuses when the requirement was already satisfied during the upload', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize AlreadySatisfied',
      industry: 'notary',
      clientEmail: `finalize-satisfied-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', world.requirementIds[0]!);

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('requirement_already_satisfied');
  });

  it('refuses when the Case closed during the upload', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize CaseClosed',
      industry: 'notary',
      clientEmail: `finalize-caseclosed-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    for (const id of world.requirementIds) {
      await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('case_not_open');
  });

  it('is idempotent: calling it twice never creates a second documents row', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Idempotent',
      industry: 'notary',
      clientEmail: `finalize-idempotent-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });

    const { error: secondError } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(secondError?.message).toBe('upload_session_not_finalizing'); // already 'completed'

    const { count } = await adminClient()
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('id', reservedDocumentId);
    expect(count).toBe(1);
  });

  it('THE STALE-CLAIM RACE: a late finalize call on a session reclaimed and completed by someone else is rejected, never a duplicate row', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize StaleClaimRace',
      industry: 'notary',
      clientEmail: `finalize-stalerace-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);

    // Caller A claims first.
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    // Simulate the cleanup job reclaiming A's stale lease (design spec's own worked trace) by
    // directly forcing the row back to 'pending' — this stands in for
    // reclaim_stale_finalizing_sessions() (Task 5), which isn't built yet at this point in the
    // plan; the RPC's own guard is what's under test here, not the reclaim job itself.
    await adminClient()
      .from('document_upload_sessions')
      .update({ status: 'pending', claimed_at: null })
      .eq('id', sessionId);

    // Caller B claims and completes the (reclaimed) session.
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 2000,
      p_verified_content_type: 'application/pdf',
    });

    // Caller A's own (stale) finalize call now finally executes.
    const { error: staleError } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000, // A's own, different, verified values
      p_verified_content_type: 'image/png',
    });
    expect(staleError?.message).toBe('upload_session_not_finalizing');

    // Exactly one documents row exists, with B's values, not A's.
    const { data: doc, count } = await adminClient()
      .from('documents')
      .select('size_bytes, content_type', { count: 'exact' })
      .eq('id', reservedDocumentId);
    expect(count).toBe(1);
    expect(doc?.[0]).toMatchObject({ size_bytes: 2000, content_type: 'application/pdf' });
  });

  it('a Client with no grant on this session cannot finalize it — same RLS-collapses-to-not_found reasoning as claim', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize TenantIsolation',
      industry: 'notary',
      clientEmail: `finalize-tenant-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);
    const other = await createOrganizationWithOwner('Notaría Finalize TenantOther', 'notary');

    const { error } = await other.owner.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('upload_session_not_found');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/document-upload-sessions.test.ts`
Expected: all pass (7 tests in this describe block, 19 total in the file).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260805170200_finalize_document_upload_rpc.sql src/types/database.ts tests/isolation/document-upload-sessions.test.ts
git commit -m "Add finalize_document_upload RPC: live-status guard closes the stale-claim race without a lease token"
```

---

## Task 4: `cancel_upload_session` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260805170300_cancel_upload_session_rpc.sql`
- Modify: `tests/isolation/document-upload-sessions.test.ts`

**Interfaces:**
- Consumes: `document_upload_sessions` (Task 1).
- Produces: `public.cancel_upload_session(p_session_id uuid) returns void` — Task 8's Server Action calls this.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260805170300_cancel_upload_session_rpc.sql

create or replace function public.cancel_upload_session(p_session_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_status text;
begin
  -- Authorization: RLS already scopes this SELECT to the caller's own participant_id (Task 2's
  -- claim RPC comment explains why there is no separate not_authorized branch here).
  select organization_id into v_org_id from public.document_upload_sessions where id = p_session_id;
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

  select status into v_status from public.document_upload_sessions where id = p_session_id for update;

  -- Cancel can never touch a session mid-finalize — the lease resolves on its own (completes, or
  -- goes stale and becomes reclaimable by a future finalize attempt or by cleanup).
  if v_status = 'finalizing' then
    raise exception using errcode = 'P0001', message = 'upload_finalize_in_progress';
  elsif v_status = 'completed' then
    raise exception using errcode = 'P0001', message = 'upload_already_completed';
  elsif v_status = 'pending' then
    update public.document_upload_sessions set status = 'cancelled' where id = p_session_id;
  end if;
  -- status in ('cancelled', 'expired'): no-op, idempotent — falls through silently.
end;
$$;

revoke all on function public.cancel_upload_session(uuid) from public;
grant execute on function public.cancel_upload_session(uuid) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `cancel_upload_session` appears in `src/types/database.ts`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/document-upload-sessions.test.ts`**

```typescript
describe('cancel_upload_session', () => {
  it('cancels a pending session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Pending',
      industry: 'notary',
      clientEmail: `cancel-pending-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error).toBeNull();

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('cancelled');
  });

  it('refuses to cancel a session mid-finalize', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel MidFinalize',
      industry: 'notary',
      clientEmail: `cancel-midfinalize-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_finalize_in_progress');

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('finalizing'); // untouched
  });

  it('refuses to cancel an already-completed session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Completed',
      industry: 'notary',
      clientEmail: `cancel-completed-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_already_completed');
  });

  it('is idempotent from a terminal state', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Idempotent',
      industry: 'notary',
      clientEmail: `cancel-idempotent-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'cancelled' });

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error).toBeNull(); // no-op, not an error
  });

  it('a Client with no grant on this session cannot cancel it — same RLS-collapses-to-not_found reasoning as claim', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel TenantIsolation',
      industry: 'notary',
      clientEmail: `cancel-tenant-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);
    const other = await createOrganizationWithOwner('Notaría Cancel TenantOther', 'notary');

    const { error } = await other.owner.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_not_found');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/document-upload-sessions.test.ts`
Expected: all pass (5 tests in this describe block, 24 total in the file).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260805170300_cancel_upload_session_rpc.sql src/types/database.ts tests/isolation/document-upload-sessions.test.ts
git commit -m "Add cancel_upload_session RPC: refuses mid-finalize, idempotent from terminal states"
```

---

## Task 5: Cleanup — three independent functions + `pg_cron` scheduling + isolation tests

**Files:**
- Create: `supabase/migrations/20260805170400_upload_session_cleanup.sql`
- Modify: `tests/isolation/document-upload-sessions.test.ts`

**Interfaces:**
- Consumes: `document_upload_sessions` (Task 1).
- Produces: `app.reclaim_stale_finalizing_sessions() returns void`, `app.expire_stale_pending_sessions() returns void` — scheduled independently via `pg_cron`. The Storage-deletion step (part C of the design) is a separate Deno Edge Function, built in this same task.

- [ ] **Step 1: Write the migration file (the two SQL cleanup functions + cron scheduling)**

```sql
-- supabase/migrations/20260805170400_upload_session_cleanup.sql
--
-- Three independent cleanup steps (design spec section 4): A and B here are pure Postgres and
-- run on their own schedule; C (the actual Storage object deletion) is a separate Edge Function
-- (supabase/functions/cleanup-upload-sessions/index.ts) so a transient HTTP failure there can
-- never block A or B from keeping the session table's own state correct.

create or replace function app.reclaim_stale_finalizing_sessions()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.document_upload_sessions
     set status = case when expires_at <= now() then 'expired' else 'pending' end,
         claimed_at = null
   where status = 'finalizing'
     and claimed_at <= now() - interval '5 minutes';
$$;

comment on function app.reclaim_stale_finalizing_sessions() is
  'Reclaims a finalizing session whose 5-minute lease has gone stale, back to pending (or directly
   to expired if its own expires_at has also passed). Never touches a finalizing row within its
   live lease. Independent of expire_stale_pending_sessions() and the Storage-deletion step.';

revoke all on function app.reclaim_stale_finalizing_sessions() from public;

create or replace function app.expire_stale_pending_sessions()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.document_upload_sessions
     set status = 'expired'
   where status = 'pending'
     and expires_at <= now();
$$;

comment on function app.expire_stale_pending_sessions() is
  'Expires a pending session whose expires_at has passed. Independent of
   reclaim_stale_finalizing_sessions() and the Storage-deletion step — a pending session expires
   on its own schedule regardless of whether any finalizing reclaim happened this pass.';

revoke all on function app.expire_stale_pending_sessions() from public;

do $$
begin
  perform cron.unschedule('avanza-reclaim-stale-upload-sessions')
  where exists (select 1 from cron.job where jobname = 'avanza-reclaim-stale-upload-sessions');
  perform cron.schedule(
    'avanza-reclaim-stale-upload-sessions',
    '*/5 * * * *',
    $job$ select app.reclaim_stale_finalizing_sessions(); $job$
  );

  perform cron.unschedule('avanza-expire-stale-upload-sessions')
  where exists (select 1 from cron.job where jobname = 'avanza-expire-stale-upload-sessions');
  perform cron.schedule(
    'avanza-expire-stale-upload-sessions',
    '*/5 * * * *',
    $job$ select app.expire_stale_pending_sessions(); $job$
  );
end;
$$;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/document-upload-sessions.test.ts`**

```typescript
// These call the app.* functions directly via withDb (a raw Postgres connection), matching this
// project's own established pattern for testing app-schema functions with no public RPC wrapper
// (see tests/isolation/case-stages-workflow.test.ts's use of the same helper).
// Add this import: import { withDb } from '../helpers/db';

describe('reclaim_stale_finalizing_sessions / expire_stale_pending_sessions', () => {
  it('reclaims a finalizing session past its lease to pending', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup ReclaimToPending',
      industry: 'notary',
      clientEmail: `cleanup-reclaim-pending-${randomUUID()}@example.test`,
    });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: staleClaimedAt });

    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status, claimed_at')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('pending');
    expect(after?.claimed_at).toBeNull();
  });

  it('reclaims a finalizing session past its lease directly to expired when expires_at also passed', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup ReclaimToExpired',
      industry: 'notary',
      clientEmail: `cleanup-reclaim-expired-${randomUUID()}@example.test`,
    });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const { sessionId } = await insertSession(world, {
      status: 'finalizing',
      claimedAt: staleClaimedAt,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('expired');
  });

  it('never touches a finalizing session within its live lease', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup LiveLease',
      industry: 'notary',
      clientEmail: `cleanup-livelease-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: new Date().toISOString() });

    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('finalizing'); // untouched
  });

  it('expires a pending session whose expires_at has passed', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup ExpirePending',
      industry: 'notary',
      clientEmail: `cleanup-expirepending-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    await withDb((db) => db.query('select app.expire_stale_pending_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('expired');
  });

  it('reclaim and expire run independently: a failure simulated in one never affects the other', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup Independence',
      industry: 'notary',
      clientEmail: `cleanup-independence-${randomUUID()}@example.test`,
    });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const { sessionId: finalizingId } = await insertSession(world, { status: 'finalizing', claimedAt: staleClaimedAt });
    const { sessionId: pendingId } = await insertSession(world, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    // Run only expire_stale_pending_sessions — proves reclaim never needed to run first or
    // alongside it for expire's own effect to be correct.
    await withDb((db) => db.query('select app.expire_stale_pending_sessions()'));
    const { data: pendingAfter } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', pendingId)
      .single();
    expect(pendingAfter?.status).toBe('expired');

    // The stale finalizing session is still untouched — expire_stale_pending_sessions never
    // reaches into 'finalizing' rows at all.
    const { data: finalizingUntouched } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', finalizingId)
      .single();
    expect(finalizingUntouched?.status).toBe('finalizing');

    // Now run reclaim on its own — proves it works standalone too.
    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));
    const { data: finalizingAfter } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', finalizingId)
      .single();
    expect(finalizingAfter?.status).toBe('pending');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/document-upload-sessions.test.ts`
Expected: all pass (5 tests in this describe block, 29 total in the file).

- [ ] **Step 5: Write the Storage-deletion Edge Function (step C)**

Create `supabase/functions/cleanup-upload-sessions/index.ts`, mirroring `supabase/functions/send-reminders/index.ts`'s exact established shape (Deno-native, self-contained, secret-gated, fail-closed if secrets are missing):

```typescript
// Edge Function: delete the Storage objects for expired/cancelled upload sessions.
//
// This is the one place the outside world (Storage's own HTTP API) is touched for cleanup. The
// two purely-internal reclaim/expire steps (app.reclaim_stale_finalizing_sessions(),
// app.expire_stale_pending_sessions()) already ran via pg_cron and moved the relevant rows to
// 'expired'/'cancelled' before this function ever runs — this function's only job is deleting the
// underlying Storage object for a row already in one of those terminal states, on its own
// schedule. A transient failure here leaves an orphan for the NEXT run to retry; it never blocks
// or is blocked by the two SQL steps (design spec section 4, step C).
declare const Deno: { env: { get(key: string): string | undefined } };

import { createClient } from 'jsr:@supabase/supabase-js@2';

const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPLOAD_CLEANUP_TRIGGER_SECRET',
] as const;

const BATCH_SIZE = 200;

function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (request: Request) => {
  const missing = REQUIRED_SECRETS.filter((name) => !Deno.env.get(name));
  if (missing.length > 0) {
    return Response.json({ error: 'not configured', missing_count: missing.length }, { status: 503 });
  }

  const triggerSecret = Deno.env.get('UPLOAD_CLEANUP_TRIGGER_SECRET')!;
  const presented = request.headers.get('x-trigger-secret') ?? '';
  if (!secretsMatch(presented, triggerSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Rows in a terminal state whose Storage object hasn't been confirmed removed. There's no
  // separate "storage_deleted_at" column in this MVP — a session in ('expired','cancelled') is
  // simply attempted every run; a successful storage.remove() on an already-absent object is not
  // an error (Supabase Storage's remove() is idempotent for a missing key), so re-attempting a
  // row already cleaned up in a prior run is harmless, not a bug.
  const { data: sessions, error } = await admin
    .from('document_upload_sessions')
    .select('id, bucket, storage_path')
    .in('status', ['expired', 'cancelled'])
    .limit(BATCH_SIZE);

  if (error) return Response.json({ error: `read sessions: ${error.message}` }, { status: 500 });

  let deleted = 0;
  let failed = 0;

  for (const s of sessions ?? []) {
    try {
      const { error: removeError } = await admin.storage.from(s.bucket).remove([s.storage_path]);
      if (removeError) throw new Error(removeError.message);
      deleted += 1;
    } catch (cause) {
      failed += 1;
      console.error('Failed to delete an orphaned upload session object', { sessionId: s.id, cause });
    }
  }

  return Response.json({ deleted, failed, total: sessions?.length ?? 0 });
});
```

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260805170400_upload_session_cleanup.sql src/types/database.ts tests/isolation/document-upload-sessions.test.ts supabase/functions/cleanup-upload-sessions/index.ts
git commit -m "Add upload session cleanup: independent reclaim/expire SQL steps + Storage-deletion Edge Function"
```

---

## Task 6: `prepareUploadAction` Server Action + integration tests

**Files:**
- Modify: `src/application/client-portal.ts` (add `prepareUpload`)
- Modify: `src/app/portal/actions.ts` (add `prepareUploadAction`)
- Create: `tests/integration/prepare-upload-action.test.ts`

**Interfaces:**
- Consumes: `resolveMyGrant` (existing, `src/features/case-access/invitations.ts`), `documentObjectPath` (existing, `src/lib/storage/paths.ts`), `ALLOWED_CONTENT_TYPES`/`MAX_DOCUMENT_BYTES` (existing, `src/features/documents/schemas.ts`).
- Produces: `prepareUpload(client: DbClient, input: { token: string; requirementId: string; fileName: string; contentType: string; sizeBytes: number }): Promise<{ sessionId: string; signedUrl: string; token: string; path: string }>` in `src/application/client-portal.ts`; `prepareUploadAction(token, requirementId, fileName, contentType, sizeBytes): Promise<ActionResult<{ sessionId: string; signedUrl: string; token: string; path: string }>>` in `src/app/portal/actions.ts`. Task 8 consumes both the RPCs and this action's shape for `finalizeUploadAction`; Task 7's client-side upload module consumes exactly `{ signedUrl, token }` from this action's success payload.

- [ ] **Step 1: Add `prepareUpload` to `src/application/client-portal.ts`**

Add this function after the existing `uploadRequirementDocument` (do not modify or remove that function yet — Task 10 retires it, separately, only after end-to-end validation):

```typescript
const prepareUploadInputSchema = z.object({
  token: z.string().min(1),
  requirementId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(500),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});

export interface PrepareUploadInput {
  readonly token: string;
  readonly requirementId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface PrepareUploadResult {
  readonly sessionId: string;
  readonly signedUrl: string;
  readonly token: string;
  readonly path: string;
}

/**
 * Step 1 of the prepare/upload/finalize flow (design.md, portal-upload-progress). Validates
 * exactly what uploadRequirementDocument already validates today, reserves a
 * document_upload_sessions row FIRST, then mints the signed upload URL — never the reverse order,
 * which would leave a valid upload credential with no internal record if minting failed after the
 * row existed.
 */
export async function prepareUpload(client: DbClient, input: PrepareUploadInput): Promise<PrepareUploadResult> {
  let parsed;
  try {
    parsed = parseInput(prepareUploadInputSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError('validation', 'Revisa el archivo: solo PDF o imágenes de hasta 25 MB.', error.issues);
    }
    throw error;
  }

  const grant = await resolveMyGrant(client, parsed.token);
  if (!grant || !grant.isActive) {
    throw new UseCaseError('forbidden', 'Tu acceso a este expediente ya no está disponible.');
  }
  if (grant.permission !== 'upload') {
    throw new UseCaseError('forbidden', 'No puedes subir documentos en este momento.');
  }

  const { data: requirement, error: reqError } = await client
    .from('requirements')
    .select('organization_id, case_id, participant_id, status')
    .eq('id', parsed.requirementId)
    .maybeSingle();

  if (reqError) throw new UseCaseError('unexpected', 'No pudimos leer ese requisito.');
  if (!requirement || requirement.participant_id !== grant.participantId) {
    throw new UseCaseError('not_found', 'Ese requisito ya no está disponible para ti.');
  }
  if (requirement.status === 'satisfied') {
    throw new UseCaseError('conflict', 'Este requisito ya fue aprobado y no se puede reemplazar.');
  }

  const reservedDocumentId = randomUUID();
  const path = documentObjectPath({
    organizationId: requirement.organization_id,
    caseId: requirement.case_id,
    requirementId: parsed.requirementId,
    documentId: reservedDocumentId,
  });

  const now = Date.now();
  const { data: session, error: insertError } = await client
    .from('document_upload_sessions')
    .insert({
      organization_id: requirement.organization_id,
      case_id: requirement.case_id,
      requirement_id: parsed.requirementId,
      participant_id: grant.participantId,
      storage_path: path,
      original_file_name: parsed.fileName,
      declared_content_type: parsed.contentType,
      declared_size_bytes: parsed.sizeBytes,
      signed_url_expires_at: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
      reserved_document_id: reservedDocumentId,
      expires_at: new Date(now + 30 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (insertError || !session) {
    throw new UseCaseError('unexpected', 'No pudimos preparar la subida. Intenta de nuevo.');
  }

  const { data: signed, error: signError } = await client.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path);

  if (signError || !signed) {
    // The row exists but the credential never did — mark it cancelled rather than leaving a
    // dangling 'pending' row with no way to ever be uploaded to.
    await client.from('document_upload_sessions').update({ status: 'cancelled' }).eq('id', session.id);
    throw new UseCaseError('forbidden', 'No pudimos preparar la subida. Intenta de nuevo.');
  }

  return { sessionId: session.id, signedUrl: signed.signedUrl, token: signed.token, path };
}
```

Add `import { z } from 'zod';` if not already imported in this file, and `import { ALLOWED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '@/features/documents/schemas';` (check this file's existing imports first — it likely already imports these for `uploadRequirementDocument`'s own schema).

- [ ] **Step 2: Add `prepareUploadAction` to `src/app/portal/actions.ts`**

```typescript
export async function prepareUploadAction(
  token: string,
  requirementId: string,
  fileName: string,
  contentType: string,
  sizeBytes: number,
): Promise<ActionResult<PrepareUploadResult>> {
  try {
    const supabase = await createClient();
    return ok(await prepareUpload(supabase, { token, requirementId, fileName, contentType, sizeBytes }));
  } catch (error) {
    return fail(error);
  }
}
```

Add `prepareUpload, type PrepareUploadResult` to the existing import from `@/application/client-portal`.

- [ ] **Step 3: Write the failing tests**

```typescript
// tests/integration/prepare-upload-action.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { prepareUpload } from '@/application/client-portal';

describe('prepareUpload', () => {
  it('reserves a session row and returns a usable signed upload URL', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload Happy',
      industry: 'notary',
      clientEmail: `prepare-happy-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'prepare-happy-token' });

    const result = await prepareUpload(granted.client, {
      token: 'prepare-happy-token',
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
    });

    expect(result.signedUrl).toMatch(/^http/);
    expect(result.token).toBeTruthy();
    expect(result.path).toContain(world.requirementIds[0]!);

    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('status, storage_path, declared_size_bytes, declared_content_type, participant_id')
      .eq('id', result.sessionId)
      .single();
    expect(session).toMatchObject({
      status: 'pending',
      storage_path: result.path,
      declared_size_bytes: 1000,
      declared_content_type: 'application/pdf',
      participant_id: world.participantId,
    });
  });

  it('rejects an oversized file before creating any session row', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload Oversized',
      industry: 'notary',
      clientEmail: `prepare-oversized-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'prepare-oversized-token' });

    await expect(
      prepareUpload(granted.client, {
        token: 'prepare-oversized-token',
        requirementId: world.requirementIds[0]!,
        fileName: 'huge.pdf',
        contentType: 'application/pdf',
        sizeBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ reason: 'validation' });

    const { count } = await adminClient()
      .from('document_upload_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('requirement_id', world.requirementIds[0]!);
    expect(count).toBe(0);
  });

  it('rejects a requirement that already belongs to someone else\'s participant', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload WrongParticipant',
      industry: 'notary',
      clientEmail: `prepare-wrongparticipant-a-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'prepare-wrong-token' });
    const other = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload WrongParticipant Other',
      industry: 'notary',
      clientEmail: `prepare-wrongparticipant-b-${randomUUID()}@example.test`,
    });

    await expect(
      prepareUpload(granted.client, {
        token: 'prepare-wrong-token',
        requirementId: other.requirementIds[0]!, // belongs to a different Case/participant entirely
        fileName: 'ine.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('rejects an already-satisfied requirement', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload AlreadySatisfied',
      industry: 'notary',
      clientEmail: `prepare-satisfied-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'prepare-satisfied-token' });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', world.requirementIds[0]!);

    await expect(
      prepareUpload(granted.client, {
        token: 'prepare-satisfied-token',
        requirementId: world.requirementIds[0]!,
        fileName: 'ine.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/prepare-upload-action.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/application/client-portal.ts src/app/portal/actions.ts tests/integration/prepare-upload-action.test.ts
git commit -m "Add prepareUpload/prepareUploadAction: reserve session before minting the signed URL"
```

---

## Task 7: Client-side direct XHR upload module + progress/cancel UI

**Files:**
- Create: `src/lib/upload/direct-upload.ts`
- Modify: `src/app/portal/[token]/portal-client.tsx` (`RequirementCard`)
- Create: `tests/component/requirement-card-upload-progress.test.tsx`

**Interfaces:**
- Produces: `uploadFileDirectly(input: { signedUrl: string; token: string; file: File; onProgress: (percent: number) => void; signal: AbortSignal }): Promise<void>` in `src/lib/upload/direct-upload.ts` — Task 8 wires this into `RequirementCard`'s upload flow alongside `prepareUploadAction`/`finalizeUploadAction`.

- [ ] **Step 1: Write the failing test for the upload module**

```typescript
// tests/unit/direct-upload.test.ts
import { describe, expect, it, vi } from 'vitest';
import { uploadFileDirectly } from '@/lib/upload/direct-upload';

// jsdom's XMLHttpRequest is a real, usable implementation for this — no need to mock the class
// itself, only the network layer underneath it via a fake XHR that this test controls directly.
class FakeXHR {
  static instances: FakeXHR[] = [];
  method = '';
  url = '';
  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  body: unknown;
  aborted = false;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

describe('uploadFileDirectly', () => {
  it('PUTs to the signed URL with the token appended, and reports progress', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error test double
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.instances = [];

    const onProgress = vi.fn();
    const controller = new AbortController();
    const file = new File(['hello'], 'ine.pdf', { type: 'application/pdf' });

    const promise = uploadFileDirectly({
      signedUrl: 'http://127.0.0.1:54421/storage/v1/object/upload/sign/case-documents/some/path',
      token: 'the-token',
      file,
      onProgress,
      signal: controller.signal,
    });

    const xhr = FakeXHR.instances[0]!;
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toContain('token=the-token');
    expect(xhr.body).toBeInstanceOf(FormData);

    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
    expect(onProgress).toHaveBeenCalledWith(50);

    xhr.status = 200;
    xhr.onload?.();
    await promise;

    globalThis.XMLHttpRequest = originalXHR;
  });

  it('rejects when the underlying XHR reports an error status', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error test double
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.instances = [];

    const promise = uploadFileDirectly({
      signedUrl: 'http://127.0.0.1:54421/storage/v1/object/upload/sign/case-documents/some/path',
      token: 'the-token',
      file: new File(['x'], 'x.pdf', { type: 'application/pdf' }),
      onProgress: () => {},
      signal: new AbortController().signal,
    });

    const xhr = FakeXHR.instances[0]!;
    xhr.status = 409;
    xhr.onload?.();

    await expect(promise).rejects.toThrow();
    globalThis.XMLHttpRequest = originalXHR;
  });

  it('rejects when the abort signal fires mid-upload', async () => {
    const originalXHR = globalThis.XMLHttpRequest;
    // @ts-expect-error test double
    globalThis.XMLHttpRequest = FakeXHR;
    FakeXHR.instances = [];

    const controller = new AbortController();
    const promise = uploadFileDirectly({
      signedUrl: 'http://127.0.0.1:54421/storage/v1/object/upload/sign/case-documents/some/path',
      token: 'the-token',
      file: new File(['x'], 'x.pdf', { type: 'application/pdf' }),
      onProgress: () => {},
      signal: controller.signal,
    });

    const xhr = FakeXHR.instances[0]!;
    controller.abort();
    expect(xhr.aborted).toBe(true);

    await expect(promise).rejects.toThrow();
    globalThis.XMLHttpRequest = originalXHR;
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run tests/unit/direct-upload.test.ts`
Expected: FAIL — `Cannot find module '@/lib/upload/direct-upload'`.

- [ ] **Step 3: Implement `src/lib/upload/direct-upload.ts`**

Replicates `uploadToSignedUrl`'s exact wire request (verified in the design spec against `storage-js@2.110.8`: `PUT` to `{signedUrl}` with `?token=` already embedded — Supabase's `createSignedUploadUrl` response already includes the token in `signedUrl`, so this module does not need to append it itself; `cacheControl` + the file appended under the empty-string key in a `FormData` body), via `XMLHttpRequest` for real progress and abort support that `fetch()` cannot provide.

```typescript
/**
 * Uploads a file directly to a Supabase Storage signed upload URL, via XMLHttpRequest rather than
 * fetch() — this is a deliberate choice, not an oversight: the Fetch API has no standardized,
 * cross-browser mechanism for observing upload progress, while XMLHttpRequest.upload.onprogress
 * (paired with xhr.abort() for real cancellation) does. Verified against storage-js's own
 * uploadToSignedUrl implementation (design spec section 1/2): same method (PUT), same FormData
 * shape (cacheControl + the file appended under the empty-string key) — this function reproduces
 * that exact wire request so the server side of the exchange is unchanged.
 */
export interface UploadFileDirectlyInput {
  readonly signedUrl: string;
  readonly token: string;
  readonly file: File;
  readonly onProgress: (percent: number) => void;
  readonly signal: AbortSignal;
}

export function uploadFileDirectly(input: UploadFileDirectlyInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = new URL(input.signedUrl);
    url.searchParams.set('token', input.token);
    xhr.open('PUT', url.toString());

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      input.onProgress(Math.round((event.loaded / event.total) * 100));
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    if (input.signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'));
      return;
    }
    input.signal.addEventListener('abort', () => xhr.abort(), { once: true });

    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', input.file);
    xhr.send(body);
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/unit/direct-upload.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Wire progress/cancel state into `RequirementCard` — `src/app/portal/[token]/portal-client.tsx`**

`RequirementCard`'s `onFile` handler and its `busy: boolean` state need to become richer to carry a percentage and a cancel affordance. Replace the existing `const [busy, setBusy] = useState(false);` with:

```typescript
const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'finalizing'>('idle');
const [uploadPercent, setUploadPercent] = useState(0);
const abortControllerRef = useRef<AbortController | null>(null);
```

Replace the existing `async function onFile(...)` body (leave the `<input>` element and its `onChange={onFile}` wiring unchanged) — this task only prepares the UI contract; Task 8 fills in the real `prepareUploadAction`/`uploadFileDirectly`/`finalizeUploadAction` calls, since those Server Actions don't exist as a full pipeline until Task 8. For this task, stub the body with a comment marking the exact insertion point Task 8 completes, and add the cancel button and progress bar markup now so Task 8's component tests can assert against real, already-rendered elements:

```typescript
async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  // Task 8 fills in: prepareUploadAction -> uploadFileDirectly (this module) -> finalizeUploadAction.
  // This task only establishes uploadPhase/uploadPercent/abortControllerRef and their UI.
}

function cancelUpload() {
  abortControllerRef.current?.abort();
}
```

Add, near the existing upload button markup (the `r.state === "pending"`/`"rejected"` branches), a progress bar + cancel button rendered only while `uploadPhase !== 'idle'`:

```tsx
{uploadPhase !== 'idle' && (
  <div className="mt-2.5">
    <div className="h-1.5 overflow-hidden rounded-full bg-app-bg">
      <div
        className="h-full rounded-full bg-royal-500 transition-[width] duration-200 ease-out"
        style={{ width: `${uploadPhase === 'finalizing' ? 100 : uploadPercent}%` }}
      />
    </div>
    <div className="mt-1.5 flex items-center justify-between">
      <span className="text-xs text-text-secondary">
        {uploadPhase === 'finalizing' ? 'Confirmando…' : `Subiendo… ${uploadPercent}%`}
      </span>
      {uploadPhase === 'uploading' && (
        <button onClick={cancelUpload} className="text-xs font-medium text-error hover:underline">
          Cancelar
        </button>
      )}
    </div>
  </div>
)}
```

- [ ] **Step 6: Write the component test**

```typescript
// tests/component/requirement-card-upload-progress.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/app/portal/actions', () => ({
  uploadRequirementDocumentAction: vi.fn(),
  getClientDocumentUrlAction: vi.fn(),
  prepareUploadAction: vi.fn(),
  finalizeUploadAction: vi.fn(),
  cancelUploadSessionAction: vi.fn(),
}));

// Imported after the mocks above per this project's established component-test convention
// (see tests/component/stage-stepper.test.tsx).
import { Checklist } from '@/app/portal/[token]/portal-client';
import type { PortalState } from '@/application/client-portal';

function baseState(overrides: Partial<PortalState> = {}): PortalState {
  return {
    organizationName: 'Notaría Test',
    caseTitle: 'Compraventa',
    caseState: 'open',
    requirements: [{ id: 'r1', label: 'INE', state: 'pending', reopenedFromRequirementId: null }],
    pendingCount: 1,
    isComplete: false,
    correctionsPending: [],
    workflowComplete: false,
    ...overrides,
  };
}

describe('RequirementCard — upload progress UI scaffold', () => {
  it('shows no progress bar before any file is selected', () => {
    render(<Checklist token="tok" state={baseState()} onChanged={() => {}} />);
    expect(screen.queryByText(/Subiendo…/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  });
});
```

Note: this task's test is deliberately minimal (proving only that the progress/cancel scaffold doesn't render prematurely) — Task 8 extends this same file with the real click-a-file → progress → cancel/complete interaction tests, once `onFile`'s real body exists to drive.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/unit/direct-upload.test.ts tests/component/requirement-card-upload-progress.test.tsx`
Expected: 4 passed (3 + 1).

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/upload/direct-upload.ts src/app/portal/[token]/portal-client.tsx tests/unit/direct-upload.test.ts tests/component/requirement-card-upload-progress.test.tsx
git commit -m "Add direct XHR upload module + progress/cancel UI scaffold in RequirementCard"
```

---

## Task 8: `finalizeUploadAction`/`cancelUploadSessionAction` + wire the full pipeline + the `upsert:false` regression test

**Files:**
- Modify: `src/application/client-portal.ts` (add `finalizeUpload`, `cancelUploadSession`)
- Modify: `src/app/portal/actions.ts` (add `finalizeUploadAction`, `cancelUploadSessionAction`)
- Modify: `src/app/portal/[token]/portal-client.tsx` (complete `onFile`'s real body)
- Modify: `tests/component/requirement-card-upload-progress.test.tsx`
- Create: `tests/integration/finalize-upload-action.test.ts` (includes the permanent `upsert:false` regression test)

**Interfaces:**
- Consumes: `claim_upload_session_for_finalize`/`finalize_document_upload`/`cancel_upload_session` (Tasks 2-4), `prepareUpload`/`PrepareUploadResult` (Task 6), `uploadFileDirectly` (Task 7).
- Produces: `finalizeUpload(client: DbClient, sessionId: string, verifiedSizeBytes: number, verifiedContentType: string): Promise<string>` and `cancelUploadSession(client: DbClient, sessionId: string): Promise<void>` in `client-portal.ts`; `finalizeUploadAction(sessionId, verifiedSizeBytes, verifiedContentType): Promise<ActionResult<{ documentId: string }>>` and `cancelUploadSessionAction(sessionId): Promise<ActionResult<null>>` in `actions.ts`.

- [ ] **Step 1: Add `finalizeUpload` and `cancelUploadSession` to `src/application/client-portal.ts`**

```typescript
/**
 * Step 3 of the prepare/upload/finalize flow. Calls claim_upload_session_for_finalize FIRST — if
 * the session is already completed, this returns immediately without ever calling Storage.info().
 * Only when not already completed does it inspect the real uploaded object and call
 * finalize_document_upload with the VERIFIED (not declared) size/content-type.
 */
export async function finalizeUpload(client: DbClient, sessionId: string): Promise<string> {
  const { data: claimed, error: claimError } = await client
    .rpc('claim_upload_session_for_finalize', { p_session_id: sessionId })
    .single();
  if (claimError) throw mapUploadSessionError(claimError);
  if (claimed.already_completed) return claimed.completed_document_id!;

  const { data: session, error: readError } = await client
    .from('document_upload_sessions')
    .select('bucket, storage_path, declared_size_bytes, declared_content_type')
    .eq('id', sessionId)
    .single();
  if (readError || !session) {
    throw new UseCaseError('unexpected', 'No pudimos confirmar la subida. Intenta de nuevo.');
  }

  const { data: info, error: infoError } = await client.storage.from(session.bucket).info(session.storage_path);
  if (infoError || !info) {
    throw new UseCaseError('unexpected', 'No encontramos el archivo subido. Intenta de nuevo.');
  }
  if (info.size <= 0 || info.size !== session.declared_size_bytes) {
    throw new UseCaseError('validation', 'El archivo subido no coincide con lo esperado. Intenta de nuevo.');
  }

  const { data: documentId, error: finalizeError } = await client.rpc('finalize_document_upload', {
    p_session_id: sessionId,
    p_verified_size_bytes: info.size,
    p_verified_content_type: info.contentType ?? session.declared_content_type,
  });
  if (finalizeError) throw mapUploadSessionError(finalizeError);

  return documentId!;
}

export async function cancelUploadSession(client: DbClient, sessionId: string): Promise<void> {
  const { data: session } = await client
    .from('document_upload_sessions')
    .select('bucket, storage_path')
    .eq('id', sessionId)
    .maybeSingle();

  const { error } = await client.rpc('cancel_upload_session', { p_session_id: sessionId });
  if (error) throw mapUploadSessionError(error);

  if (session) {
    try {
      await client.storage.from(session.bucket).remove([session.storage_path]);
    } catch (cause) {
      console.error('Failed to delete a cancelled upload session\'s Storage object', { sessionId, cause });
    }
  }
}

// No 'not_authorized' key: RLS on document_upload_sessions already scopes every read to the
// caller's own participant_id, so an inaccessible session is indistinguishable from a
// nonexistent one at the RPC layer (upload_session_not_found covers both) — see Task 2's
// claim_upload_session_for_finalize RPC comment for the full reasoning, matching this codebase's
// established getPortalCase precedent.
const UPLOAD_SESSION_MESSAGES: Record<string, string> = {
  upload_session_not_found: 'Esa sesión de subida ya no existe.',
  upload_finalize_in_progress: 'Estamos confirmando tu archivo, intenta de nuevo en unos segundos.',
  upload_session_cancelled: 'Esta subida fue cancelada. Selecciona el archivo de nuevo.',
  upload_session_expired: 'Esta subida expiró. Selecciona el archivo de nuevo.',
  upload_session_not_finalizing: 'Esta subida ya no está en curso.',
  requirement_already_satisfied: 'Este requisito ya fue aprobado y no se puede reemplazar.',
  grant_no_longer_active: 'Tu acceso a este expediente ya no está disponible.',
  case_not_open: 'Este expediente ya no está abierto.',
  upload_already_completed: 'Esta subida ya se completó.',
};

function mapUploadSessionError(error: { message: string }): UseCaseError {
  const message = UPLOAD_SESSION_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos procesar la subida. Intenta de nuevo.');
  const reason =
    error.message === 'upload_session_not_found' ? 'not_found'
    : error.message === 'requirement_already_satisfied' ? 'conflict'
    : 'conflict';
  return new UseCaseError(reason, message);
}
```

- [ ] **Step 2: Add the two Server Actions to `src/app/portal/actions.ts`**

```typescript
export async function finalizeUploadAction(sessionId: string): Promise<ActionResult<{ documentId: string }>> {
  try {
    const supabase = await createClient();
    const documentId = await finalizeUpload(supabase, sessionId);
    return ok({ documentId });
  } catch (error) {
    return fail(error);
  }
}

export async function cancelUploadSessionAction(sessionId: string): Promise<ActionResult<null>> {
  try {
    const supabase = await createClient();
    await cancelUploadSession(supabase, sessionId);
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
```

Add `finalizeUpload, cancelUploadSession` to the existing import from `@/application/client-portal`.

- [ ] **Step 3: Complete `RequirementCard`'s `onFile` in `src/app/portal/[token]/portal-client.tsx`**

```typescript
async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  setUploadError(null);
  setUploadPhase('uploading');
  setUploadPercent(0);
  const controller = new AbortController();
  abortControllerRef.current = controller;

  const prepared = await prepareUploadAction(token, r.id, file.name, file.type, file.size);
  if (!prepared.ok) {
    setUploadError(prepared.message);
    setUploadPhase('idle');
    return;
  }

  try {
    await uploadFileDirectly({
      signedUrl: prepared.data.signedUrl,
      token: prepared.data.token,
      file,
      onProgress: setUploadPercent,
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      await cancelUploadSessionAction(prepared.data.sessionId);
      setUploadPhase('idle');
      return;
    }
    setUploadError('No pudimos subir el archivo. Vuelve a intentarlo.');
    setUploadPhase('idle');
    return;
  }

  setUploadPhase('finalizing');
  const finalized = await finalizeUploadAction(prepared.data.sessionId);
  setUploadPhase('idle');

  if (!finalized.ok) {
    setUploadError(finalized.message);
    return;
  }
  onChanged();
}
```

Add the imports `prepareUploadAction, finalizeUploadAction, cancelUploadSessionAction` from `./actions` (or the correct relative path already used by this file's existing action imports) and `uploadFileDirectly` from `@/lib/upload/direct-upload`.

- [ ] **Step 4: Extend the component test — `tests/component/requirement-card-upload-progress.test.tsx`**

```typescript
// Add to the top-level mock of '@/app/portal/actions', keep the existing keys:
// (already includes prepareUploadAction, finalizeUploadAction, cancelUploadSessionAction as vi.fn())

import { prepareUploadAction, finalizeUploadAction, cancelUploadSessionAction } from '@/app/portal/actions';
vi.mock('@/lib/upload/direct-upload', () => ({ uploadFileDirectly: vi.fn() }));
import { uploadFileDirectly } from '@/lib/upload/direct-upload';

describe('RequirementCard — full upload pipeline', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows progress during upload, then Confirmando during finalize, then clears on success', async () => {
    vi.mocked(prepareUploadAction).mockResolvedValue({
      ok: true,
      data: { sessionId: 's1', signedUrl: 'http://x', token: 't1', path: 'p1' },
    });
    let resolveUpload!: () => void;
    vi.mocked(uploadFileDirectly).mockImplementation(
      (input) =>
        new Promise((resolve) => {
          resolveUpload = () => {
            input.onProgress(42);
            resolve();
          };
        }),
    );
    vi.mocked(finalizeUploadAction).mockResolvedValue({ ok: true, data: { documentId: 'd1' } });

    render(<Checklist token="tok" state={baseState()} onChanged={vi.fn()} />);
    const user = userEvent.setup();
    const file = new File(['x'], 'ine.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]')!;
    await user.upload(input as HTMLInputElement, file);

    resolveUpload();
    await screen.findByText('Confirmando…');
  });

  it('cancels the upload and calls cancelUploadSessionAction', async () => {
    vi.mocked(prepareUploadAction).mockResolvedValue({
      ok: true,
      data: { sessionId: 's1', signedUrl: 'http://x', token: 't1', path: 'p1' },
    });
    vi.mocked(uploadFileDirectly).mockImplementation(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
        }),
    );
    vi.mocked(cancelUploadSessionAction).mockResolvedValue({ ok: true, data: null });

    render(<Checklist token="tok" state={baseState()} onChanged={vi.fn()} />);
    const user = userEvent.setup();
    const file = new File(['x'], 'ine.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]')!;
    await user.upload(input as HTMLInputElement, file);

    await screen.findByRole('button', { name: 'Cancelar' });
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(cancelUploadSessionAction).toHaveBeenCalledWith('s1');
  });
});
```

- [ ] **Step 5: Write the integration tests, including the permanent `upsert:false` regression test**

```typescript
// tests/integration/finalize-upload-action.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { prepareUpload, finalizeUpload, cancelUploadSession } from '@/application/client-portal';

describe('finalizeUpload', () => {
  it('completes a real prepare -> upload -> finalize cycle end to end', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Action Happy',
      industry: 'notary',
      clientEmail: `finalize-action-happy-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'finalize-happy-token' });

    const prepared = await prepareUpload(granted.client, {
      token: 'finalize-happy-token',
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 11,
    });

    const put = await fetch(`${prepared.signedUrl}?token=${prepared.token}`, {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['hello world'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    expect(put.ok).toBe(true);

    const documentId = await finalizeUpload(granted.client, prepared.sessionId);

    const { data: doc } = await adminClient()
      .from('documents')
      .select('size_bytes, content_type, requirement_id')
      .eq('id', documentId)
      .single();
    expect(doc).toMatchObject({ size_bytes: 11, content_type: 'application/pdf', requirement_id: world.requirementIds[0] });
  });

  it('a retry of finalizeUpload on an already-completed session returns the same documentId without touching Storage again', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Action Retry',
      industry: 'notary',
      clientEmail: `finalize-action-retry-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'finalize-retry-token' });
    const prepared = await prepareUpload(granted.client, {
      token: 'finalize-retry-token',
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 5,
    });
    await fetch(`${prepared.signedUrl}?token=${prepared.token}`, {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['hello'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    const first = await finalizeUpload(granted.client, prepared.sessionId);
    const second = await finalizeUpload(granted.client, prepared.sessionId);
    expect(second).toBe(first);
  });

  it('THE UPSERT:FALSE REGRESSION TEST — a second PUT with the same token and different bytes is rejected, and the original object is unchanged (design spec section 5)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upsert False Regression',
      industry: 'notary',
      clientEmail: `upsert-false-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'upsert-false-token' });
    const prepared = await prepareUpload(granted.client, {
      token: 'upsert-false-token',
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 7,
    });

    const putA = await fetch(`${prepared.signedUrl}?token=${prepared.token}`, {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['AAAAAAA'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    expect(putA.ok).toBe(true);

    const { data: infoAfterA } = await adminClient().storage.from('case-documents').info(prepared.path);

    const putB = await fetch(`${prepared.signedUrl}?token=${prepared.token}`, {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['BBBBBBBBBBBB'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    expect(putB.status).toBe(409);

    const { data: infoAfterB } = await adminClient().storage.from('case-documents').info(prepared.path);
    expect(infoAfterB?.version).toBe(infoAfterA?.version);
    expect(infoAfterB?.size).toBe(7);
  });

  it('cancelUploadSession deletes the pending session\'s Storage object', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Action Deletes Object',
      industry: 'notary',
      clientEmail: `cancel-action-deletes-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token: 'cancel-deletes-token' });
    const prepared = await prepareUpload(granted.client, {
      token: 'cancel-deletes-token',
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 5,
    });
    await fetch(`${prepared.signedUrl}?token=${prepared.token}`, {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['hello'], { type: 'application/pdf' }));
        return fd;
      })(),
    });

    await cancelUploadSession(granted.client, prepared.sessionId);

    const { data: infoAfter } = await adminClient().storage.from('case-documents').info(prepared.path);
    expect(infoAfter).toBeNull();
  });
});
```

- [ ] **Step 6: Run all the tests**

Run: `npx vitest run tests/integration/finalize-upload-action.test.ts tests/component/requirement-card-upload-progress.test.tsx`
Expected: all pass (4 + 3).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/application/client-portal.ts src/app/portal/actions.ts src/app/portal/[token]/portal-client.tsx tests/integration/finalize-upload-action.test.ts tests/component/requirement-card-upload-progress.test.tsx
git commit -m "Wire the full prepare/upload/finalize pipeline; add the permanent upsert:false regression test"
```

---

## Task 9: End-to-end validation of the new flow (before touching the old path)

**Files:** none created/modified beyond verification.

**Interfaces:** none new.

- [ ] **Step 1: Full local test suite**

Run: `npx vitest run`
Expected: every test file passes, including all new files from Tasks 1-8, with zero regressions in every pre-existing test.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual verification checklist (real browser, local dev server)**

Using `npm run dev` against the local (reset + reseeded) database:
1. Open a Portal link for a seeded Participant, select a pending requirement, choose a real file (a few MB, large enough to see the progress bar move). Confirm the progress bar advances smoothly from 0% toward 100%, not a static spinner.
2. Confirm the "Cancelar" button appears during upload and, when clicked mid-transfer, the upload stops, the UI returns to its pre-upload state, and — via `adminClient` or the Supabase Studio UI — confirm the session row is `cancelled` and the Storage object is gone.
3. Let an upload complete normally. Confirm the requirement's state updates to "En revisión" without a page reload (`onChanged()`'s existing `refreshState` behavior), and confirm exactly one row exists in `documents` for it.
4. Kill the dev server (simulating a crashed tab) mid-upload once, restart it, and confirm the orphaned session row is eventually reclaimed/expired by manually invoking `select app.reclaim_stale_finalizing_sessions(); select app.expire_stale_pending_sessions();` (since `pg_cron` may not have fired yet in a short manual test) and that the Storage-deletion Edge Function invoked directly (`curl` with the right secret header) removes the orphaned object.
5. Attempt to reuse a signed URL from a completed upload in a second `curl` PUT (matching Task 8's own automated regression test) and confirm it fails with 409 in the running dev environment too, not only in the isolated test.

- [ ] **Step 4: If manual verification surfaces any bugs, fix them here, re-run the affected automated tests, and commit the fix with an honest description of what was wrong**

Do not proceed to Task 10 until this task's checklist passes cleanly.

---

## Task 10: Retire the old upload proxy path (separate, revertible commit)

**Files:**
- Modify: `src/application/client-portal.ts` (remove `uploadRequirementDocument`)
- Modify: `src/app/portal/actions.ts` (remove `uploadRequirementDocumentAction`)
- Modify: `src/app/portal/[token]/portal-client.tsx` (remove any remaining reference to the old action, if any placeholder was left)
- Modify: any test file that still references the retired function/action

**Interfaces:**
- Removes: `uploadRequirementDocument`, `uploadRequirementDocumentAction`. Nothing in this plan's own new code depends on either — this task is purely deletion plus its own test cleanup.

This task must only be started after Task 9's checklist is fully green. Keeping it separate means the old path can be reverted with a single `git revert` of this one commit if the new flow needs more time in production, without touching anything built in Tasks 1-9.

- [ ] **Step 1: Repo-wide sweep for the old function/action names**

Run: `grep -rn "uploadRequirementDocument\b" --include='*.ts' --include='*.tsx' /Users/paolabramlett/DocuFlow/src /Users/paolabramlett/DocuFlow/tests`

Expected: hits only in `src/application/client-portal.ts` (the function definition), `src/app/portal/actions.ts` (the Server Action wrapper), and any test file(s) still exercising the old path directly (e.g. an older `tests/integration/*.test.ts` written against `uploadRequirementDocument` before this plan existed) — note every path found here before proceeding.

- [ ] **Step 2: Remove `uploadRequirementDocument` from `src/application/client-portal.ts`**

Delete the function and its dedicated `uploadInputSchema`/`UploadRequirementDocumentInput` (confirm nothing else in the file still references them — `prepareUpload`'s own schema, `prepareUploadInputSchema`, is separate and unaffected).

- [ ] **Step 3: Remove `uploadRequirementDocumentAction` from `src/app/portal/actions.ts`**

Delete the Server Action and drop `uploadRequirementDocument` from its import of `@/application/client-portal` (keep `prepareUpload`, `finalizeUpload`, `cancelUploadSession`, etc.).

- [ ] **Step 4: Update any test file found in Step 1 that still calls the old path**

For each file, either delete tests that exist purely to exercise the retired function, or (if the file also contains still-relevant tests for other behavior) remove only the specific `describe`/`it` blocks calling `uploadRequirementDocument`/`uploadRequirementDocumentAction`.

- [ ] **Step 5: Full suite, typecheck, lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: all pass, zero references to the retired names anywhere (re-run Step 1's grep to confirm zero hits outside this plan's own documentation).

- [ ] **Step 6: Commit**

```bash
git add src/application/client-portal.ts src/app/portal/actions.ts <any test files touched in step 4>
git commit -m "Retire the old single-Server-Action upload proxy path, now that prepare/upload/finalize is validated end to end"
```
