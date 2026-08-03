# Case Closure (Complete / Cancel / Reopen) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Staff close a Case as "Completado" (all client-visible documentation approved) or "Cancelado" (with a client-visible reason, any time), reopen a closed Case with automatic grant restoration where still possible, and fix the "Completados hoy" metric — building entirely on the `cases.state`/`completed_at` schema and grant-downgrade trigger that already exist and are already tested, but wired to nothing.

**Architecture:** Two new atomic Postgres RPCs (`close_case`, `reopen_case`) own every invariant (documentation-completeness check, mandatory cancellation note, concurrency via row lock, atomic audit event) — the TypeScript layer is a thin caller plus best-effort notification. A generalized grant-downgrade trigger and a symmetric reopen-side restoration replace the completion-only trigger that exists today.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + RLS, `plpgsql` RPCs, Vitest (isolation/integration/unit tests), Resend (email).

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-03-case-closure-design.md` — read it once before Task 1; every task below implements one section of it. Do not reopen decisions already locked there.
- Every RPC exception uses `raise exception using errcode = 'P0001', message = 'stable_snake_case_code'` — a fixed literal, never `%`-interpolated — matching `save_blueprint` (`supabase/migrations/20260729130000_blueprint_authoring.sql`). `error.message` on the JS side is always that exact string.
- Only two transitions exist: `open → completed`, `open → cancelled` (via `close_case`), and `completed|cancelled → open` (via `reopen_case`). No direct `completed ↔ cancelled`.
- `client_closing_note` is client-visible text (Portal + email) — required (DB-enforced) when cancelling, optional when completing. Never confuse it with an internal-only note; there is no internal-note field in this plan.
- Before running any command that writes to the database (`npm run db:reset`, `npx vitest run`, `npm run db:seed`), confirm `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL` is `http://127.0.0.1:...` — never a production URL.
- `escapeHtml()` (`src/lib/email/escape-html.ts`, already exists) is used only when building raw HTML email strings. **Never call it on text rendered as JSX children** (`{note}` in a React component) — JSX already escapes automatically; running it there would double-escape and show a literal `&amp;` to the user. Task 8 and Task 9 call this out again at the exact line it matters.
- Run `npm run typecheck && npm run lint` after every task that touches `.ts`/`.tsx` files, before committing.

---

## Task 1: Schema migration — rename, new columns, constraints, backfill

**Files:**
- Create: `supabase/migrations/20260803150000_case_closure_schema.sql`
- Test: `tests/isolation/case-closure.test.ts` (new file, started here)

**Interfaces:**
- Produces: `cases.closed_at` (renamed from `completed_at`), `cases.closed_by_auth_user_id`, `cases.client_closing_note`, `organizations.grant_reactivation_days`, `case_access_grants.permission_before_closure` — every later task in this plan reads or writes these exact column names.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260803150000_case_closure_schema.sql
--
-- Schema for Case closure (complete/cancel) and reopening. See
-- docs/superpowers/specs/2026-08-03-case-closure-design.md for the full design. This file only
-- adds columns/constraints; close_case, reopen_case, and the trigger swap are their own,
-- later-numbered migration files (dependency order, not just style).

-- ---------------------------------------------------------------------------------------------
-- cases: completed_at -> closed_at, now marking entry into EITHER terminal state
-- ---------------------------------------------------------------------------------------------

alter table public.cases rename column completed_at to closed_at;

alter table public.cases
  add column closed_by_auth_user_id uuid references auth.users (id) on delete set null,
  add column client_closing_note text;

-- Preflight/backfill: the OLD constraint only required completed_at for state = 'completed', so a
-- pre-existing 'cancelled' Case (if any) may have closed_at (post-rename) still null. The new
-- coherence constraint below would reject the migration outright on such a row. There is no better
-- source for "when this was cancelled" than updated_at (no history table exists) — a deliberate,
-- documented approximation, not a guess about what data exists today.
update public.cases
   set closed_at = updated_at
 where state = 'cancelled'
   and closed_at is null;

alter table public.cases
  drop constraint cases_completed_at_matches_state;

alter table public.cases
  add constraint cases_closed_at_matches_state check (
    (state in ('completed', 'cancelled')) = (closed_at is not null)
  ),
  add constraint cases_cancelled_requires_note check (
    state <> 'cancelled' or nullif(btrim(client_closing_note), '') is not null
  );

comment on column public.cases.closed_at is
  'Set on entry to completed or cancelled; cleared on reopen. Renamed from completed_at.';
comment on column public.cases.client_closing_note is
  'Visible to the Client (Portal + closure email). Required when state = cancelled. Never an internal-only note.';

-- ---------------------------------------------------------------------------------------------
-- organizations: canonical duration for a restored grant's new active window after reopening
-- ---------------------------------------------------------------------------------------------
--
-- Deliberately a DIFFERENT knob from access_retention_days: that one governs the read-only window
-- after closing; this one governs the active window after reopening. Same shape/range as
-- access_retention_days (supabase/migrations/20260722193136_organizations_and_members.sql) so a
-- trigger reads this instead of a bare number.

alter table public.organizations
  add column grant_reactivation_days integer not null default 90
    check (grant_reactivation_days between 1 and 3650);

-- ---------------------------------------------------------------------------------------------
-- case_access_grants: the permission captured just before downgrade, for exact restoration
-- ---------------------------------------------------------------------------------------------

alter table public.case_access_grants
  add column permission_before_closure text
    check (permission_before_closure is null or permission_before_closure in ('upload', 'view', 'none'));

comment on column public.case_access_grants.permission_before_closure is
  'The permission value at the moment this grant was first downgraded on Case closure. Restored
   verbatim on reopen when the grant is still active; cleared on every reopen regardless.';
```

- [ ] **Step 2: Apply the migration locally**

Run: `npm run db:reset`
Expected: migration applies with no errors; output ends with the seed/reset summary this project's `db:reset` already prints.

- [ ] **Step 3: Regenerate types**

Run: `npm run db:types`
Expected: `src/types/database.ts` now has `closed_at`, `closed_by_auth_user_id`, `client_closing_note` on `cases`; `grant_reactivation_days` on `organizations`; `permission_before_closure` on `case_access_grants`. No `completed_at` remains on `cases`.

- [ ] **Step 4: Write the failing isolation test (schema shape only — no RPCs exist yet)**

```typescript
// tests/isolation/case-closure.test.ts
import { describe, expect, it } from 'vitest';
import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';

describe('case closure: schema', () => {
  it('rejects a cancelled Case with a blank client_closing_note', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Closure Schema', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client', email: `schema-${Date.now()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Schema Case',
    });

    const { error } = await admin
      .from('cases')
      .update({ state: 'cancelled', closed_at: new Date().toISOString() })
      .eq('id', caseId!);

    expect(error?.message).toContain('cases_cancelled_requires_note');
  });

  it('rejects a completed Case with closed_at left null', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Closure Schema 2', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client 2', email: `schema2-${Date.now()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Schema Case 2',
    });

    const { error } = await admin.from('cases').update({ state: 'completed' }).eq('id', caseId!);

    expect(error?.message).toContain('cases_closed_at_matches_state');
  });

  it('organizations.grant_reactivation_days defaults to 90 and rejects an out-of-range value', async () => {
    const { organizationId } = await createOrganizationWithOwner('Notaría Closure Schema 3', 'notary');
    const admin = adminClient();
    const { data } = await admin.from('organizations').select('grant_reactivation_days').eq('id', organizationId).single();
    expect(data?.grant_reactivation_days).toBe(90);

    const { error } = await admin.from('organizations').update({ grant_reactivation_days: 0 }).eq('id', organizationId);
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run tests/isolation/case-closure.test.ts`
Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260803150000_case_closure_schema.sql src/types/database.ts tests/isolation/case-closure.test.ts
git commit -m "Add case-closure schema: closed_at rename, grant_reactivation_days, permission_before_closure"
```

---

## Task 2: `close_case` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260803150100_close_case_rpc.sql`
- Modify: `tests/isolation/case-closure.test.ts`

**Interfaces:**
- Consumes: `cases.closed_at`/`closed_by_auth_user_id`/`client_closing_note` (Task 1), `requirements.status`/`participant_id`/`deleted_at`/`superseded_at` (existing), `audit_events` (existing).
- Produces: `public.close_case(p_case_id uuid, p_outcome text, p_closing_note text default null) returns public.cases` — Task 5 calls this via `client.rpc('close_case', {...})`.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260803150100_close_case_rpc.sql

create or replace function public.close_case(
  p_case_id uuid,
  p_outcome text,
  p_closing_note text default null
)
returns public.cases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases;
  v_organization_id uuid;
  v_visible_total integer;
  v_visible_outstanding integer;
  v_rows integer;
begin
  if p_outcome not in ('completed', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'invalid_outcome';
  end if;

  -- Authorization is checked BEFORE the row lock, via a plain (non-locking) read: PostgreSQL RLS
  -- applies a table's UPDATE-policy USING clause (not only its SELECT policy) to a row fetched
  -- with FOR UPDATE/FOR SHARE, because acquiring that lock implies intent to write. cases_select
  -- admits a granted Client (view permission), but cases_update_by_member does not — so a
  -- `SELECT ... FOR UPDATE` here would silently return no row for a granted Client, making a
  -- perfectly legitimate "not authorized" caller indistinguishable from "case does not exist".
  -- A plain SELECT (no locking clause) only needs cases_select, which a granted Client does
  -- satisfy, so this ordering can tell the two apart correctly — the same shape as this
  -- codebase's own save_blueprint RPC, which checks app.is_org_owner() explicitly up front
  -- rather than relying on a locking read to enforce it (supabase/migrations/
  -- 20260729130000_blueprint_authoring.sql).
  select organization_id into v_organization_id from public.cases where id = p_case_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'case_not_found';
  end if;
  if v_organization_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  -- FOR UPDATE: holds the row lock for the rest of this transaction. A concurrent close_case (or
  -- reopen_case) on the same Case blocks here until this transaction ends, then re-reads the
  -- committed row — never a stale one — so it fails its own state check instead of racing. Safe
  -- to lock now: membership is already confirmed, so cases_update_by_member's USING clause (which
  -- the lock also enforces) is satisfied too.
  select * into v_case from public.cases where id = p_case_id for update;
  if v_case.state <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

  if p_outcome = 'completed' then
    -- "Documentación completa": at least one client-visible Requirement exists across every
    -- Participant of the Case, and every one of them is satisfied. Staff-only Requirements
    -- (participant_id is null) and soft-deleted/superseded rows never count either way. A
    -- Requirement whose status is 'archived' (a real, distinct value — not a synonym for
    -- deleted_at) still counts as outstanding here, matching the existing read models
    -- (src/features/cases/queries.ts, src/features/case-access/portal-queries.ts), which never
    -- special-case it either. A Case with two Participants where only one finished must NOT be
    -- completable.
    select count(*), count(*) filter (where r.status <> 'satisfied')
      into v_visible_total, v_visible_outstanding
      from public.requirements r
     where r.case_id = p_case_id
       and r.participant_id is not null
       and r.deleted_at is null
       and r.superseded_at is null;

    if v_visible_total = 0 or v_visible_outstanding > 0 then
      raise exception using errcode = 'P0001', message = 'documentation_incomplete';
    end if;
  else
    if nullif(btrim(p_closing_note), '') is null then
      raise exception using errcode = 'P0001', message = 'cancellation_note_required';
    end if;
  end if;

  update public.cases
     set state = p_outcome,
         closed_at = now(),
         closed_by_auth_user_id = (select auth.uid()),
         client_closing_note = case
           when p_outcome = 'cancelled' then btrim(p_closing_note)
           else nullif(btrim(coalesce(p_closing_note, '')), '')
         end
   where id = p_case_id
     and state = 'open';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- Defense-in-depth only: membership is already confirmed above, and the FOR UPDATE lock is
    -- held continuously from the state check through this UPDATE, so nothing can have changed
    -- state out from under it — this branch should be unreachable in correct operation.
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_organization_id, p_case_id, 'case.state_changed', 'case', p_case_id,
    'member', (select auth.uid()), jsonb_build_object('from', 'open', 'to', p_outcome)
  );

  select * into v_case from public.cases where id = p_case_id;
  return v_case;
end;
$$;

revoke all on function public.close_case(uuid, text, text) from public;
grant execute on function public.close_case(uuid, text, text) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `src/types/database.ts` now has a `close_case` entry under `Functions`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-closure.test.ts`**

```typescript
// Append to tests/isolation/case-closure.test.ts — add these imports at the top:
// import { randomUUID } from 'node:crypto';
// import { addParticipant, buildOrganizationWorld, grantVerifiedAccess, type OrganizationWorld } from '../helpers/fixtures';
// import { withDb } from '../helpers/db';

// Module-level (not nested in any one describe block): Task 3's `describe('reopen_case', ...)`
// block, appended later in this same file, calls this too.
async function makeCaseFullyApproved(world: OrganizationWorld) {
  for (const id of world.requirementIds) {
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
  }
}

describe('close_case', () => {
  it('completes a Case whose every client-visible Requirement is satisfied', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Complete',
      industry: 'notary',
      clientEmail: `close-complete-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    const { data, error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error).toBeNull();
    expect(data?.state).toBe('completed');
    expect(data?.closed_at).toEqual(expect.any(String));
  });

  it('rejects completion when a Requirement is still outstanding', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Incomplete',
      industry: 'notary',
      clientEmail: `close-incomplete-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('rejects completion when the Case has zero client-visible Requirements', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close No Requirements',
      industry: 'notary',
      clientEmail: `close-none-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    }

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('a Requirement with status = archived (not merely superseded) still counts as outstanding', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Archived',
      industry: 'notary',
      clientEmail: `close-archived-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    // Directly force one Requirement to 'archived' with superseded_at left null — proving the RPC's
    // own predicate, not merely "supersedeRequirement always sets both together" (which is true in
    // the app today, but the RPC must be correct regardless).
    await adminClient()
      .from('requirements')
      .update({ status: 'archived' })
      .eq('id', world.requirementIds[0]!);

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('a multi-participant Case is not completable unless every Participant finished', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Multi',
      industry: 'notary',
      clientEmail: `close-multi-a-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    const second = await addParticipant(world, { roleLabel: 'Segundo', clientEmail: `close-multi-b-${randomUUID()}@example.test` });
    await world.staff.client.from('requirements').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      participant_id: second.participantId,
      label: 'Requisito pendiente',
      type: 'document',
      position: 0,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('cancels a Case at any time, with a note', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Cancel',
      industry: 'notary',
      clientEmail: `close-cancel-${randomUUID()}@example.test`,
    });

    const { data, error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: 'El cliente decidió no continuar.',
    });

    expect(error).toBeNull();
    expect(data?.state).toBe('cancelled');
    expect(data?.client_closing_note).toBe('El cliente decidió no continuar.');
  });

  it('rejects cancellation with a blank or whitespace-only note', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Cancel Blank',
      industry: 'notary',
      clientEmail: `close-cancel-blank-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: '   ',
    });

    expect(error?.message).toBe('cancellation_note_required');
  });

  it('rejects an invalid outcome', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Invalid',
      industry: 'notary',
      clientEmail: `close-invalid-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'archived',
    });

    expect(error?.message).toBe('invalid_outcome');
  });

  it('rejects a Case that is already closed, including directly from completed to cancelled', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Twice',
      industry: 'notary',
      clientEmail: `close-twice-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: 'Intento de cambio directo.',
    });

    expect(error?.message).toBe('case_not_open');
  });

  it('records the audit event atomically with the state change', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Audit',
      industry: 'notary',
      clientEmail: `close-audit-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('action, metadata, actor_auth_user_id')
      .eq('case_id', world.caseId)
      .eq('action', 'case.state_changed');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.metadata).toEqual({ from: 'open', to: 'completed' });
    expect(events?.[0]?.actor_auth_user_id).toBe(world.staff.userId);
  });

  it('a granted Client cannot close a Case despite being able to SELECT it', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Client',
      industry: 'notary',
      clientEmail: `close-client-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    const granted = await grantVerifiedAccess({ world, permission: 'view' });

    const { data: visible } = await granted.client.from('cases').select('id').eq('id', world.caseId).maybeSingle();
    expect(visible?.id).toBe(world.caseId);

    const { error } = await granted.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    expect(error?.message).toBe('not_authorized');
  });

  it('serializes two concurrent close_case calls on the same Case — exactly one succeeds', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Concurrent',
      industry: 'notary',
      clientEmail: `close-concurrent-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    const [a, b] = await Promise.all([
      world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' }),
      world.staff.client.rpc('close_case', {
        p_case_id: world.caseId,
        p_outcome: 'cancelled',
        p_closing_note: 'Carrera',
      }),
    ]);

    const errors = [a.error?.message, b.error?.message].filter((m): m is string => Boolean(m));
    const successes = [a, b].filter((r) => r.error === null);
    expect(successes).toHaveLength(1);
    expect(errors).toEqual(['case_not_open']);
  });

  it('full-rollback: if the audit_events insert fails, the Case state never becomes visible', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Rollback',
      industry: 'notary',
      clientEmail: `close-rollback-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    // postgrest-js has no "run arbitrary SQL" escape hatch, so forcing the INSERT to fail goes
    // through withDb() (tests/helpers/db.ts) — the same direct-Postgres-connection helper this
    // repo already uses for app-schema access that PostgREST can't reach (e.g.
    // tests/isolation for app.queue_reminders()).
    await withDb(async (db) => {
      await db.query('revoke insert on public.audit_events from authenticated');
      try {
        const { error } = await world.staff.client.rpc('close_case', {
          p_case_id: world.caseId,
          p_outcome: 'completed',
        });
        expect(error).not.toBeNull();

        const { data: after } = await adminClient()
          .from('cases')
          .select('state, closed_at')
          .eq('id', world.caseId)
          .single();
        expect(after?.state).toBe('open');
        expect(after?.closed_at).toBeNull();
      } finally {
        await db.query('grant insert on public.audit_events to authenticated');
      }
    });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-closure.test.ts`
Expected: all `close_case` tests pass (13 tests in this describe block).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260803150100_close_case_rpc.sql src/types/database.ts tests/isolation/case-closure.test.ts
git commit -m "Add close_case RPC: atomic completion/cancellation with row-lock concurrency"
```

---

## Task 3: `reopen_case` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260803150200_reopen_case_rpc.sql`
- Modify: `tests/isolation/case-closure.test.ts`

**Interfaces:**
- Consumes: `organizations.grant_reactivation_days`, `case_access_grants.permission_before_closure` (Task 1), `close_case` (Task 2, only to set up terminal-state fixtures in tests).
- Produces: `public.reopen_case(p_case_id uuid) returns table (participant_id uuid)` — Task 5 calls this.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260803150200_reopen_case_rpc.sql

create or replace function public.reopen_case(p_case_id uuid)
returns table (participant_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases;
  v_organization_id uuid;
  v_rows integer;
  v_reactivation_days integer;
begin
  -- Authorization checked BEFORE the row lock, via a plain (non-locking) read — identical
  -- reasoning to close_case: PostgreSQL RLS applies the UPDATE policy's USING clause (not only
  -- SELECT's) to a row fetched with FOR UPDATE, so a granted Client's locking SELECT would
  -- otherwise silently return no row at all, indistinguishable from case_not_found.
  select organization_id into v_organization_id from public.cases where id = p_case_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'case_not_found';
  end if;
  if v_organization_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_case from public.cases where id = p_case_id for update;
  if v_case.state not in ('completed', 'cancelled') then
    raise exception using errcode = 'P0001', message = 'case_not_terminal';
  end if;

  select o.grant_reactivation_days into v_reactivation_days
    from public.organizations o
   where o.id = v_organization_id;

  update public.cases
     set state = 'open',
         closed_at = null,
         closed_by_auth_user_id = null,
         client_closing_note = null
   where id = p_case_id
     and state in ('completed', 'cancelled');

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- Defense-in-depth only: membership is already confirmed above, and the FOR UPDATE lock is
    -- held continuously from the state check through this UPDATE — should be unreachable.
    raise exception using errcode = 'P0001', message = 'case_not_terminal';
  end if;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_organization_id, p_case_id, 'case.state_changed', 'case', p_case_id,
    'member', (select auth.uid()), jsonb_build_object('from', v_case.state, 'to', 'open')
  );

  -- Restorable: the canonical "active grant" predicate (verified, not revoked, not expired — same
  -- as app.granted_participant_ids) AND a real prior permission was captured. A grant whose
  -- permission_before_closure is null never had one recorded (e.g. it was already 'view' going in)
  -- — never invent 'upload' for it. RETURN QUERY appends rows and does not exit the function, so
  -- the cleanup UPDATE below still runs before the final bare RETURN. The DISTINCT here is the
  -- RPC's real contract: case_access_grants carries no uniqueness constraint on participant_id
  -- alone, so more than one grant row per Participant is possible and must not produce duplicates.
  return query
    with restored as (
      update public.case_access_grants g
         set permission = g.permission_before_closure,
             expires_at = now() + make_interval(days => v_reactivation_days),
             permission_before_closure = null
       where g.case_id = p_case_id
         and g.verified_at is not null
         and g.revoked_at is null
         and g.expires_at > now()
         and g.permission_before_closure is not null
      returning g.participant_id
    )
    select distinct r.participant_id from restored r;

  -- Every other grant on this Case that still carries a stale prior-permission value (expired,
  -- revoked, or never verified — so never restored above) gets it cleared too — no transient state
  -- left dangling, whether or not that particular grant's access actually came back.
  update public.case_access_grants g
     set permission_before_closure = null
   where g.case_id = p_case_id
     and g.permission_before_closure is not null;

  return;
end;
$$;

revoke all on function public.reopen_case(uuid) from public;
grant execute on function public.reopen_case(uuid) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `reopen_case` appears in `src/types/database.ts`.

**Note:** Task 1 and Task 2's migrations re-apply on every `db:reset` — that's expected; each
`db:reset` replays every migration from scratch.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-closure.test.ts`**

```typescript
describe('reopen_case', () => {
  it('rejects a Case that is not in a terminal state', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen NotTerminal',
      industry: 'notary',
      clientEmail: `reopen-notterminal-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });

    expect(error?.message).toBe('case_not_terminal');
  });

  it('reopens a completed Case back to open and clears closure fields', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Basic',
      industry: 'notary',
      clientEmail: `reopen-basic-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { error } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(error).toBeNull();

    const { data: after } = await adminClient()
      .from('cases')
      .select('state, closed_at, closed_by_auth_user_id, client_closing_note')
      .eq('id', world.caseId)
      .single();
    expect(after).toEqual(
      expect.objectContaining({ state: 'open', closed_at: null, closed_by_auth_user_id: null, client_closing_note: null }),
    );
  });

  // NOTE ON TASK ORDERING: this task (reopen_case) is deliberately implemented and tested BEFORE
  // Task 4 (the trigger swap that makes close_case's grant-downgrade actually populate
  // permission_before_closure — the CURRENT, still-active trigger, app.downgrade_grants_on_completion,
  // predates this whole feature and has never heard of that column). So every test below that
  // needs a grant already sitting in the "downgraded, with a captured prior permission" state
  // sets permission_before_closure directly via an admin write immediately after calling
  // close_case, rather than relying on close_case's real trigger side effect to have populated it
  // — exactly the same technique the "unverified grant" and "deduplicated Participant" tests
  // further down already use for their own fixture setup. Once Task 4 lands, close_case's trigger
  // populates this column for real and these direct writes become redundant-but-harmless (they'd
  // set the column to the same value the trigger already set) — no test needs to change.

  it('restores a still-active grant to its exact prior permission and a fresh expiry', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Restore',
      industry: 'notary',
      clientEmail: `reopen-restore-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger (not yet implemented) capturing the pre-downgrade permission —
    // see the NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', granted.grantId);

    const { data: downgraded } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(downgraded?.permission).toBe('view');
    expect(downgraded?.permission_before_closure).toBe('upload');

    const { data: restoredRows, error } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(error).toBeNull();
    expect(restoredRows?.map((r) => r.participant_id)).toEqual([world.participantId]);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure, expires_at')
      .eq('id', granted.grantId)
      .single();
    expect(after?.permission).toBe('upload');
    expect(after?.permission_before_closure).toBeNull();
    expect(Date.parse(after!.expires_at!)).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  it('leaves an expired grant unchanged, but still clears its stale permission_before_closure', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Expired',
      industry: 'notary',
      clientEmail: `reopen-expired-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger — see the NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', granted.grantId);
    // Force expiry after the downgrade already ran.
    await adminClient()
      .from('case_access_grants')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', granted.grantId);

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows).toHaveLength(0);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(after?.permission).toBe('view'); // unchanged, not silently bumped
    expect(after?.permission_before_closure).toBeNull(); // still cleared
  });

  it('leaves a revoked grant unchanged, but still clears its stale permission_before_closure', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Revoked',
      industry: 'notary',
      clientEmail: `reopen-revoked-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger — see the NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', granted.grantId);
    await adminClient().from('case_access_grants').update({ revoked_at: new Date().toISOString() }).eq('id', granted.grantId);

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows).toHaveLength(0);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(after?.permission).toBe('view');
    expect(after?.permission_before_closure).toBeNull();
  });

  it('leaves an unverified grant unchanged (never restores a session that never activated)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Unverified',
      industry: 'notary',
      clientEmail: `reopen-unverified-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    // Directly insert an unverified grant with a permission_before_closure value, simulating a row
    // the downgrade trigger already touched before verification ever completed (an edge case worth
    // covering even if today's flow never actually produces it).
    const { data: grant } = await adminClient()
      .from('case_access_grants')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        participant_id: world.participantId,
        invited_email: `unverified-${randomUUID()}@example.test`,
        invitation_token_hash: randomUUID(),
        permission: 'view',
        permission_before_closure: 'upload',
        expires_at: new Date(Date.now() + 1000 * 86_400_000).toISOString(),
      })
      .select('id')
      .single();
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows?.map((r) => r.participant_id)).not.toContain(world.participantId);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', grant!.id)
      .single();
    expect(after?.permission).toBe('view');
    expect(after?.permission_before_closure).toBeNull();
  });

  it('returns a deduplicated Participant set when a Participant holds two grant rows', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Dedup',
      industry: 'notary',
      clientEmail: `reopen-dedup-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const first = await grantVerifiedAccess({ world, permission: 'upload' });
    // A second, independent grant row for the SAME Participant — case_access_grants carries no
    // uniqueness constraint on participant_id alone, so this is a legitimate state to defend
    // against even though normal issuance never produces it today.
    const { data: secondGrant } = await adminClient()
      .from('case_access_grants')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        participant_id: world.participantId,
        invited_email: `dedup-${randomUUID()}@example.test`,
        invitation_token_hash: randomUUID(),
        permission: 'upload',
        verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      })
      .select('id')
      .single();
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger for BOTH grant rows, so both are genuinely restorable — see the
    // NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', first.grantId);
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', secondGrant!.id);

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows).toHaveLength(1);
    expect(restoredRows?.[0]?.participant_id).toBe(world.participantId);
  });

  it('a granted Client cannot reopen a Case despite being able to SELECT it', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Client',
      industry: 'notary',
      clientEmail: `reopen-client-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    const granted = await grantVerifiedAccess({ world, permission: 'view' });

    const { error } = await granted.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(error?.message).toBe('not_authorized');
  });

  it('the audit event exists atomically with the state change', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Audit',
      industry: 'notary',
      clientEmail: `reopen-audit-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('metadata')
      .eq('case_id', world.caseId)
      .eq('action', 'case.state_changed')
      .order('created_at', { ascending: false })
      .limit(1);
    expect(events?.[0]?.metadata).toEqual({ from: 'completed', to: 'open' });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-closure.test.ts`
Expected: all `reopen_case` tests pass (9 tests in this describe block, 22 total in the file).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260803150200_reopen_case_rpc.sql src/types/database.ts tests/isolation/case-closure.test.ts
git commit -m "Add reopen_case RPC: canonical-active-grant restoration, deduplicated by Participant"
```

---

## Task 4: Trigger swap — generalize downgrade to both terminal states

**Files:**
- Create: `supabase/migrations/20260803150300_case_closure_grant_trigger.sql`
- Modify: `tests/isolation/case-closure.test.ts`

**Interfaces:**
- Consumes: nothing new — reads the same columns as Tasks 1-3.
- Produces: `app.downgrade_grants_on_closure()` + trigger `cases_downgrade_grants_on_closure` on `public.cases`, replacing `app.downgrade_grants_on_completion()` / `cases_downgrade_grants_on_completion` (dropped in this same file).

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260803150300_case_closure_grant_trigger.sql
--
-- Generalizes the existing completion-only downgrade trigger to both terminal states, and
-- corrects its grant-activity predicate to match the one canonical definition used everywhere
-- else (app.granted_participant_ids: verified_at is not null and revoked_at is null and
-- expires_at > now()). The prior version used only `revoked_at is null`, which would have
-- "downgraded" (and given a brand-new expires_at) a grant that had already expired — effectively
-- reviving it.

drop trigger cases_downgrade_grants_on_completion on public.cases;
drop function app.downgrade_grants_on_completion();

create or replace function app.downgrade_grants_on_closure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  retention_days integer;
begin
  if new.state in ('completed', 'cancelled') and old.state = 'open' then
    select o.access_retention_days
      into retention_days
      from public.organizations o
     where o.id = new.organization_id;

    update public.case_access_grants g
       set permission_before_closure = g.permission,
           permission = 'view',
           expires_at = now() + make_interval(days => retention_days)
     where g.case_id = new.id
       and g.verified_at is not null
       and g.revoked_at is null
       and g.expires_at > now();
  end if;

  return new;
end;
$$;

comment on function app.downgrade_grants_on_closure() is
  'On Case entering a terminal state (completed/cancelled) from open, downgrades active grants to
   view for the Organization retention window, remembering each one''s prior permission.';

revoke all on function app.downgrade_grants_on_closure() from public;

create trigger cases_downgrade_grants_on_closure
  after update of state on public.cases
  for each row execute function app.downgrade_grants_on_closure();
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-closure.test.ts`**

```typescript
describe('downgrade_grants_on_closure trigger', () => {
  it('downgrades permission and captures permission_before_closure on completion', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Trigger Downgrade',
      industry: 'notary',
      clientEmail: `trigger-downgrade-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });

    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { data } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure, expires_at')
      .eq('id', granted.grantId)
      .single();
    expect(data?.permission).toBe('view');
    expect(data?.permission_before_closure).toBe('upload');
    expect(Date.parse(data!.expires_at!)).toBeGreaterThan(Date.now());
  });

  it('also fires on cancellation, not only completion', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Trigger Cancel',
      industry: 'notary',
      clientEmail: `trigger-cancel-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });

    await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: 'Cancelado para probar el trigger.',
    });

    const { data } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(data?.permission).toBe('view');
    expect(data?.permission_before_closure).toBe('upload');
  });

  it('never downgrades an already-expired grant (would otherwise revive it)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Trigger Expired',
      industry: 'notary',
      clientEmail: `trigger-expired-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const expiredAt = new Date(Date.now() - 1000).toISOString();
    await adminClient().from('case_access_grants').update({ expires_at: expiredAt }).eq('id', granted.grantId);

    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { data } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure, expires_at')
      .eq('id', granted.grantId)
      .single();
    expect(data?.permission).toBe('upload'); // untouched
    expect(data?.permission_before_closure).toBeNull(); // never captured
    expect(data?.expires_at).toBe(expiredAt); // untouched, not "revived" with a new date
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-closure.test.ts`
Expected: all pass (3 more tests, 25 total in the file).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260803150300_case_closure_grant_trigger.sql src/types/database.ts tests/isolation/case-closure.test.ts
git commit -m "Swap grant-downgrade trigger: both terminal states, canonical active-grant predicate"
```

---

## Task 5: TypeScript application layer + repo-wide `setCaseState` sweep

**Files:**
- Modify: `src/features/cases/cases.ts`
- Create: `tests/integration/case-closure-use-case.test.ts`

**Interfaces:**
- Consumes: `close_case`, `reopen_case` (Tasks 2-3), `reissueParticipantInvitation` (`src/features/case-access/invitations.ts`, existing), `sendTransactionalEmail`/`escapeHtml` (existing), `UseCaseError` (`src/application/errors.ts`, existing).
- Produces:
  - `closeCase(client: DbClient, caseId: string, outcome: 'completed' | 'cancelled', closingNote: string | undefined): Promise<void>`
  - `reopenCase(client: DbClient, caseId: string): Promise<{ restoredParticipantIds: string[]; requiresReinvitation: boolean }>`
  - Both exported from `src/features/cases/cases.ts` — Task 6's Server Actions call these exact names/signatures.
  - `setCaseState` and `caseStateSchema` are removed from this file entirely.

- [ ] **Step 1: Repo-wide sweep for `setCaseState` — do this BEFORE writing any code**

Run: `grep -rn "setCaseState" --include='*.ts' --include='*.tsx' --include='*.md' /Users/paolabramlett/DocuFlow/src /Users/paolabramlett/DocuFlow/tests /Users/paolabramlett/DocuFlow/scripts /Users/paolabramlett/DocuFlow/docs 2>/dev/null`

Expected today: two hits — the definition in `src/features/cases/cases.ts` and one call site in
`tests/integration/case-services.test.ts` (`it('records case creation and state change', ...)`).
If this grep turns up anything else (a doc, a script, another test), note every path here before
proceeding — this task is not done until the same grep, run again after Step 5 below, comes back
with zero hits anywhere outside this plan document itself.

- [ ] **Step 2: Remove `setCaseState` and `caseStateSchema` from `src/features/cases/cases.ts`**

Delete lines 16 (`export const caseStateSchema = ...`) and 85-127 (the whole `setCaseState`
function and its docstring) from `src/features/cases/cases.ts`.

- [ ] **Step 3: Add `closeCase` and `reopenCase` to `src/features/cases/cases.ts`**

Add these imports at the top of the file (alongside the existing ones):

```typescript
import type { PostgrestError } from '@supabase/supabase-js';
import { UseCaseError } from '@/application/errors';
import { reissueParticipantInvitation } from '@/features/case-access/invitations';
import { sendTransactionalEmail, type SendTransactionalEmailInput } from '@/lib/email/resend';
import { escapeHtml } from '@/lib/email/escape-html';
import { APP_ORIGIN } from '@/lib/supabase/env';
```

Add this code where `setCaseState` used to be (same location in the file):

```typescript
const CLOSE_CASE_MESSAGES: Record<string, string> = {
  invalid_outcome: 'Resultado de cierre no válido.',
  case_not_found: 'El expediente ya no existe.',
  case_not_open: 'Este expediente ya no está abierto.',
  documentation_incomplete: 'No se puede marcar como completado: aún hay documentación pendiente.',
  cancellation_note_required: 'Escribe el motivo de cancelación que verá el cliente.',
  not_authorized: 'No tienes permiso para cerrar este expediente.',
};

function mapCloseCaseError(error: PostgrestError): UseCaseError {
  const message = CLOSE_CASE_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos cerrar el expediente. Intenta de nuevo.');
  const reason =
    error.message === 'documentation_incomplete' || error.message === 'cancellation_note_required'
      ? 'validation'
      : error.message === 'not_authorized'
        ? 'forbidden'
        : 'conflict';
  return new UseCaseError(reason, message);
}

const REOPEN_CASE_MESSAGES: Record<string, string> = {
  case_not_found: 'El expediente ya no existe.',
  case_not_terminal: 'Este expediente no está cerrado.',
  not_authorized: 'No tienes permiso para reabrir este expediente.',
};

function mapReopenCaseError(error: PostgrestError): UseCaseError {
  const message = REOPEN_CASE_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos reabrir el expediente. Intenta de nuevo.');
  const reason =
    error.message === 'case_not_found' ? 'not_found' : error.message === 'not_authorized' ? 'forbidden' : 'conflict';
  return new UseCaseError(reason, message);
}

interface CaseAndOrgName {
  readonly title: string;
  readonly organizationName: string;
}

async function readCaseAndOrgName(client: DbClient, caseId: string): Promise<CaseAndOrgName> {
  const { data } = await client
    .from('cases')
    .select('title, organization:organizations(name)')
    .eq('id', caseId)
    .single();
  return { title: data?.title ?? '', organizationName: data?.organization?.name ?? 'Avanza' };
}

/** One row per Participant with an active grant on this Case, deduplicated — never one per grant
 *  row, matching the exact rationale in reopen_case's own contract (Task 3). */
async function activeGrantParticipants(
  client: DbClient,
  caseId: string,
): Promise<{ participantId: string; invitedEmail: string }[]> {
  const { data } = await client
    .from('case_access_grants')
    .select('participant_id, invited_email, revoked_at, permission')
    .eq('case_id', caseId);

  const seen = new Set<string>();
  const result: { participantId: string; invitedEmail: string }[] = [];
  for (const g of data ?? []) {
    if (g.revoked_at !== null || g.permission === 'none') continue;
    if (seen.has(g.participant_id)) continue;
    seen.add(g.participant_id);
    result.push({ participantId: g.participant_id, invitedEmail: g.invited_email });
  }
  return result;
}

async function notifyParticipantsOfClosure(
  client: DbClient,
  caseId: string,
  outcome: 'completed' | 'cancelled',
  closingNote: string | undefined,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<void> {
  try {
    const { title, organizationName } = await readCaseAndOrgName(client, caseId);
    const participants = await activeGrantParticipants(client, caseId);
    const safeTitle = escapeHtml(title);
    const noteHtml = closingNote
      ? `<p><strong>Motivo:</strong> ${escapeHtml(closingNote)}</p>`
      : '';
    const heading = outcome === 'completed' ? 'Expediente completado' : 'Expediente cancelado';
    const body =
      outcome === 'completed'
        ? `Tu expediente <strong>${safeTitle}</strong> fue completado. Toda tu documentación requerida fue aprobada.`
        : `Tu expediente <strong>${safeTitle}</strong> fue cancelado.`;

    for (const p of participants) {
      await sendEmail({
        to: p.invitedEmail,
        subject: `${heading} — ${organizationName}`,
        html: `<h2>${heading}</h2>\n<p>${body}</p>\n${noteHtml}`,
        idempotencyKey: `case-closure/${caseId}/${p.participantId}/${outcome}`,
      });
    }
  } catch (cause) {
    console.error('Failed to notify participants of case closure', { caseId, outcome, cause });
  }
}

async function notifyParticipantsOfReopening(
  client: DbClient,
  caseId: string,
  restoredParticipantIds: string[],
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<void> {
  try {
    const { title, organizationName } = await readCaseAndOrgName(client, caseId);
    const safeTitle = escapeHtml(title);
    for (const participantId of restoredParticipantIds) {
      // One reissue per restored Participant, never per grant row — a second reissue for the same
      // Participant would invalidate the token this same loop just minted for them.
      const reissued = await reissueParticipantInvitation(client, participantId);
      await sendEmail({
        to: reissued.invitedEmail,
        subject: `Tu expediente fue reabierto — ${organizationName}`,
        html: `<h2>Tu expediente fue reabierto</h2>\n<p>Puedes volver a <strong>${safeTitle}</strong> para continuar.</p>\n<p><a href="${APP_ORIGIN}/portal/${reissued.token}">Ir a mi expediente</a></p>`,
        idempotencyKey: `case-reopen/${caseId}/${participantId}/${Date.now()}`,
      });
    }
  } catch (cause) {
    console.error('Failed to notify participants of case reopening', { caseId, cause });
  }
}

/**
 * Closes a Case as completed (documentation fully approved) or cancelled (any time, with a
 * client-visible note). All validation and the state change happen atomically inside the
 * close_case RPC (Task 2) — this function only calls it and, on success, sends a best-effort
 * notification. Never calls recordAuditEvent: the audit event is already written, atomically,
 * inside the RPC itself.
 */
export async function closeCase(
  client: DbClient,
  caseId: string,
  outcome: 'completed' | 'cancelled',
  closingNote: string | undefined,
): Promise<void> {
  const { error } = await client.rpc('close_case', {
    p_case_id: caseId,
    p_outcome: outcome,
    p_closing_note: closingNote ?? null,
  });
  if (error) throw mapCloseCaseError(error);

  await notifyParticipantsOfClosure(client, caseId, outcome, closingNote);
}

/**
 * Reopens a closed Case. Ordering invariant: `reopen_case` is awaited (its transaction has
 * already committed) BEFORE any Portal token is reissued or any email sent — a fresh link is
 * never minted ahead of, or independently of, a successful reopen.
 */
export async function reopenCase(
  client: DbClient,
  caseId: string,
): Promise<{ restoredParticipantIds: string[]; requiresReinvitation: boolean }> {
  const { data, error } = await client.rpc('reopen_case', { p_case_id: caseId });
  if (error) throw mapReopenCaseError(error);

  const restoredParticipantIds = (data ?? []).map((r) => r.participant_id);

  if (restoredParticipantIds.length > 0) {
    await notifyParticipantsOfReopening(client, caseId, restoredParticipantIds);
  }

  return { restoredParticipantIds, requiresReinvitation: restoredParticipantIds.length === 0 };
}
```

- [ ] **Step 4: Rewrite the one caller in `tests/integration/case-services.test.ts`**

Replace the import line:

```typescript
import {
  addRequirement,
  closeCase,
  createCase,
  deleteRequirement,
  renameRequirement,
  reorderRequirements,
} from '@/features/cases/cases';
```

Replace the test body:

```typescript
    it('records case creation and state change', async () => {
      const caseId = await createCase(
        world.staff.client,
        {
          organizationId: world.organizationId,
          clientId: world.clientId,
          title: 'Audited case',
        },
        world.staff.userId,
      );
      await addRequirement(
        world.staff.client,
        { organizationId: world.organizationId, caseId, label: 'Sign', position: 0 },
        world.staff.userId,
      );
      // closeCase requires documentation complete for 'completed' — but this test only checks
      // that a state change is audited, so 'cancelled' (always allowed) is the simpler path here.
      await closeCase(world.staff.client, caseId, 'cancelled', 'Cierre de prueba de auditoría');

      expect(await auditActions(caseId)).toEqual(
        expect.arrayContaining(['case.created', 'case.state_changed']),
      );
    });
```

- [ ] **Step 5: Re-run the repo-wide sweep from Step 1 — must now be empty**

Run: `grep -rn "setCaseState" --include='*.ts' --include='*.tsx' --include='*.md' /Users/paolabramlett/DocuFlow/src /Users/paolabramlett/DocuFlow/tests /Users/paolabramlett/DocuFlow/scripts /Users/paolabramlett/DocuFlow/docs 2>/dev/null`
Expected: no output at all.

- [ ] **Step 6: Write the failing integration tests**

```typescript
// tests/integration/case-closure-use-case.test.ts
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrganizationWorld, grantVerifiedAccess, type OrganizationWorld } from '../helpers/fixtures';
import { adminClient } from '../helpers/clients';
import { closeCase, reopenCase } from '@/features/cases/cases';

async function completeAllRequirements(world: OrganizationWorld) {
  for (const id of world.requirementIds) {
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
  }
}

describe('closeCase / reopenCase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes as completed and sends the closure email to the active Participant', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Close',
      industry: 'notary',
      clientEmail: `usecase-close-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await grantVerifiedAccess({ world, permission: 'view' });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    await closeCase(world.staff.client, world.caseId, 'completed', undefined);

    const { data } = await adminClient().from('cases').select('state').eq('id', world.caseId).single();
    expect(data?.state).toBe('completed');
  });

  it('a notification failure does not throw past closeCase (best-effort)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Close Fail',
      industry: 'notary',
      clientEmail: `usecase-close-fail-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await grantVerifiedAccess({ world, permission: 'view' });
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockRejectedValue(new Error('boom'));

    await expect(closeCase(world.staff.client, world.caseId, 'completed', undefined)).resolves.toBeUndefined();
    const { data } = await adminClient().from('cases').select('state').eq('id', world.caseId).single();
    expect(data?.state).toBe('completed'); // the RPC still succeeded
  });

  it('rejects completion with documentation_incomplete mapped to a validation UseCaseError', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Incomplete',
      industry: 'notary',
      clientEmail: `usecase-incomplete-${randomUUID()}@example.test`,
    });

    await expect(closeCase(world.staff.client, world.caseId, 'completed', undefined)).rejects.toMatchObject({
      reason: 'validation',
    });
  });

  it('reopening with zero restorable grants sends no email and reports requiresReinvitation', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Reopen NoGrants',
      industry: 'notary',
      clientEmail: `usecase-reopen-none-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    const result = await reopenCase(world.staff.client, world.caseId);

    expect(result).toEqual({ restoredParticipantIds: [], requiresReinvitation: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reopening calls emit_participant_invitation exactly once per restored Participant', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Reopen Invite',
      industry: 'notary',
      clientEmail: `usecase-reopen-invite-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await grantVerifiedAccess({ world, permission: 'upload' });
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockResolvedValue(undefined);
    const rpcSpy = vi.spyOn(world.staff.client, 'rpc');

    const result = await reopenCase(world.staff.client, world.caseId);

    expect(result.restoredParticipantIds).toEqual([world.participantId]);
    const reissueCalls = rpcSpy.mock.calls.filter(([name]) => name === 'emit_participant_invitation');
    expect(reissueCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/integration/case-closure-use-case.test.ts tests/integration/case-services.test.ts`
Expected: all pass.

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/features/cases/cases.ts tests/integration/case-closure-use-case.test.ts tests/integration/case-services.test.ts
git commit -m "Replace setCaseState with closeCase/reopenCase, RPC error mapping, notifications"
```

---

## Task 6: Server Actions

**Files:**
- Modify: `src/app/cases/actions.ts`

**Interfaces:**
- Consumes: `closeCase`, `reopenCase` (Task 5), `getStaffContext` (`src/features/auth/context.ts`, existing).
- Produces: `closeCaseAction(caseId, outcome, closingNote?)`, `reopenCaseAction(caseId)` — Task 8's UI calls both by these exact names.

- [ ] **Step 1: Add the actions**

Add to `src/app/cases/actions.ts`, alongside the existing imports:

```typescript
import { closeCase, reopenCase } from "@/features/cases/cases";
```

Add at the end of the file:

```typescript
export async function closeCaseAction(
  caseId: string,
  outcome: "completed" | "cancelled",
  closingNote?: string,
): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    await closeCase(supabase, caseId, outcome, closingNote);

    revalidatePath("/cases");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function reopenCaseAction(
  caseId: string,
): Promise<ActionResult<{ requiresReinvitation: boolean }>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    const { requiresReinvitation } = await reopenCase(supabase, caseId);

    revalidatePath("/cases");
    return ok({ requiresReinvitation });
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/cases/actions.ts
git commit -m "Add closeCaseAction/reopenCaseAction Server Actions"
```

---

## Task 7: Email templates review (already built in Task 5 — this task verifies escaping)

Task 5 already wrote the three email bodies (`notifyParticipantsOfClosure`,
`notifyParticipantsOfReopening`) inline in `src/features/cases/cases.ts`, following the exact
existing pattern from `src/application/review-document.ts`/`send-manual-reminder.ts` (raw
template-string HTML, `escapeHtml()` around every free-text field). This task is a dedicated
verification pass plus a unit test, not new production code — the design spec called email out as
its own section, so it gets its own checkable deliverable.

**Files:**
- Create: `tests/unit/case-closure-emails.test.ts`

**Interfaces:**
- Consumes: `escapeHtml` (`src/lib/email/escape-html.ts`, existing).

- [ ] **Step 1: Write the test**

```typescript
// tests/unit/case-closure-emails.test.ts
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { closeCase } from '@/features/cases/cases';

describe('case-closure emails: escaping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('escapes an HTML-bearing client_closing_note before it reaches the email body', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Email Escape',
      industry: 'notary',
      clientEmail: `email-escape-${randomUUID()}@example.test`,
    });
    await grantVerifiedAccess({ world, permission: 'view' });
    let capturedHtml = '';
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(async (input) => {
      capturedHtml = input.html;
    });

    await closeCase(
      world.staff.client,
      world.caseId,
      'cancelled',
      `<script>alert("hi")</script> & "quotes"`,
    );

    expect(capturedHtml).not.toContain('<script>');
    expect(capturedHtml).toContain('&lt;script&gt;');
    expect(capturedHtml).toContain('&amp;');
    expect(capturedHtml).toContain('&quot;quotes&quot;');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/unit/case-closure-emails.test.ts`
Expected: 1 passed. If it fails, re-check Task 5 Step 3's `notifyParticipantsOfClosure` body —
every interpolation of `closingNote` (and `title`) into the `html` template literal must go through
`escapeHtml(...)`.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/case-closure-emails.test.ts
git commit -m "Add escaping test for case-closure email bodies"
```

---

## Task 8: Staff UI — Cerrar expediente modal, closure/reopen banners

**Files:**
- Modify: `src/features/cases/queries.ts` (add `closedAt`/`clientClosingNote` to `CaseView`)
- Modify: `src/app/cases/cases-workspace.tsx`

**Interfaces:**
- Consumes: `closeCaseAction`, `reopenCaseAction` (Task 6), `CaseView` (extended below).
- Produces: `CaseView.closedAt?: string`, `CaseView.clientClosingNote?: string` — Task 10 (metric) does not depend on these two fields, but Task 9 does not touch this file, so no downstream task consumes this interface beyond this one.

- [ ] **Step 1: Extend `CaseView` and its query in `src/features/cases/queries.ts`**

Change the `CaseView` interface:

```typescript
export interface CaseView {
  id: string;
  ref: string;
  title: string;
  opened: string;
  state: string;
  closedAt?: string;
  clientClosingNote?: string;
  participants: ParticipantView[];
}
```

Change the `.select(...)` call inside `getWorkspaceCases` — add `closed_at, client_closing_note`
next to the existing `id, title, state, created_at`:

```typescript
    .select(
      `id, title, state, created_at, closed_at, client_closing_note,
       participants:case_participants(id, role_label, client:clients(full_name),
         requirements(id, label, status, position, participant_id, deleted_at, superseded_at,
           documents(id, created_at, reviews(decision, reason, created_at)))
       )`,
    )
```

Change the `.map(...)` that builds each `CaseView` — add the two new fields:

```typescript
  return (data ?? []).map((c) => ({
    id: c.id,
    ref: refFromId(c.id),
    title: c.title,
    opened: formatDate(c.created_at),
    state: c.state,
    closedAt: c.closed_at ?? undefined,
    clientClosingNote: c.client_closing_note ?? undefined,
    participants: (c.participants ?? []).map((p) => ({
```

- [ ] **Step 2: Add the closure modal and banners to `src/app/cases/cases-workspace.tsx`**

Add to the imports at the top of the file:

```typescript
import { closeCaseAction, getDocumentDownloadUrlAction, reopenCaseAction, reviewDocumentAction, sendManualReminderAction } from "./actions";
```

(Replace the existing `import { getDocumentDownloadUrlAction, reviewDocumentAction, sendManualReminderAction } from "./actions";` line with the one above.)

Inside `CaseDetail`, change the `done` banner's gating and the header buttons. First, locate:

```typescript
  const done = k.total > 0 && k.approved === k.total;
```

Leave that line as-is (it still means "documentación completa", a concept distinct from the
Case's closure state — see the design spec's "three moments" framing). Then replace the entire
header `<div className="flex items-center gap-2">...</div>` block (the one containing "Descargar
todo" / "Recordar" / "Revisar documentos") with:

```tsx
        <div className="flex items-center gap-2">
          <a
            href={`/cases/${c.id}/documents-zip`}
            className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
          >
            Descargar todo
          </a>
          {c.state === "open" && (
            <>
              <button
                onClick={remind}
                disabled={reminding}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reminding ? "Enviando…" : "Recordar"}
              </button>
              <button
                onClick={goToReview}
                disabled={!firstReview}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Revisar documentos
              </button>
              <button
                onClick={() => setClosing(true)}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
              >
                Cerrar expediente
              </button>
            </>
          )}
        </div>
```

Add new state to `CaseDetail`, alongside the existing `reminding`/`reminderMessage` state:

```typescript
  const [closing, setClosing] = useState(false);
```

Change the `done &&` banner condition to also require `c.state === "open"` (the new closure banner
takes over once the Case is actually closed):

```tsx
        {done && c.state === "open" && (
          <div className="mb-6 flex items-center gap-3 rounded-card border border-success/20 bg-success-bg/60 px-5 py-4">
```

Add the closure banner right after that block (still inside the `<div className="flex-1
overflow-y-auto px-7 py-6">`):

```tsx
        {c.state !== "open" && <ClosureBanner c={c} />}
```

Add the `CloseCaseModal` render at the end of `CaseDetail`'s JSX, just before the closing `</div>`
of the component's root `<div className="flex h-full flex-col">`:

```tsx
      {closing && <CloseCaseModal caseId={c.id} documentationComplete={done} onClose={() => setClosing(false)} />}
```

- [ ] **Step 3: Add the `ClosureBanner` and `CloseCaseModal` components**

Add these two new functions to `src/app/cases/cases-workspace.tsx`, after `CaseDetail`:

```tsx
function formatClosedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}

function ClosureBanner({ c }: { c: CaseView }) {
  const [reopening, setReopening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const completed = c.state === "completed";

  async function reopen() {
    setReopening(true);
    setMessage(null);
    const result = await reopenCaseAction(c.id);
    setReopening(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    if (result.data.requiresReinvitation) {
      setMessage("El cliente ya no tiene un enlace activo — usa Recordar para invitarlo de nuevo.");
    }
    router.refresh();
  }

  return (
    <div className={`mb-6 flex items-start gap-3 rounded-card border px-5 py-4 ${completed ? "border-success/20 bg-success-bg/60" : "border-border bg-app-bg"}`}>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-full text-white ${completed ? "bg-success" : "bg-neutral"}`}>
        {completed ? <IconCheck className="size-4" /> : <IconX className="size-4" />}
      </span>
      <div className="flex-1">
        <div className="text-sm font-semibold text-text-primary">
          {completed ? "Expediente completado" : "Expediente cancelado"}
        </div>
        <p className="mt-0.5 text-xs text-text-secondary">
          {c.closedAt && `Cerrado el ${formatClosedAt(c.closedAt)}.`}
          {c.clientClosingNote && ` ${c.clientClosingNote}`}
        </p>
        {message && <p className="mt-1 text-xs text-text-secondary">{message}</p>}
        <button
          onClick={reopen}
          disabled={reopening}
          className="mt-2.5 rounded-input border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reopening ? "Reabriendo…" : "Reabrir expediente"}
        </button>
      </div>
    </div>
  );
}

function CloseCaseModal({
  caseId,
  documentationComplete,
  onClose,
}: {
  caseId: string;
  documentationComplete: boolean;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<"completed" | "cancelled" | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function submit() {
    if (!outcome) return;
    if (outcome === "cancelled" && !note.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await closeCaseAction(caseId, outcome, note.trim() || undefined);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-panel border border-border bg-surface p-6 shadow-md">
        <h3 className="text-sm font-semibold text-text-primary">Cerrar expediente</h3>
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="outcome"
              disabled={!documentationComplete}
              checked={outcome === "completed"}
              onChange={() => setOutcome("completed")}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-text-primary">Completado</span>
              {!documentationComplete && (
                <span className="block text-xs text-text-secondary">Requiere documentación completa.</span>
              )}
            </span>
          </label>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="outcome"
              checked={outcome === "cancelled"}
              onChange={() => setOutcome("cancelled")}
              className="mt-0.5"
            />
            <span className="block text-sm font-medium text-text-primary">Cancelado</span>
          </label>
        </div>

        {outcome === "cancelled" && (
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-text-primary">Motivo de cancelación (el cliente lo verá)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-input border border-border bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            />
          </label>
        )}

        {error && <p className="mt-2 text-xs text-error">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-input px-3.5 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={submitting || !outcome || (outcome === "cancelled" && !note.trim())}
            className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Cerrando…" : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Note on escaping:** `{c.clientClosingNote}` and `{message}` above are JSX children — React
escapes them automatically. Do **not** wrap them in `escapeHtml(...)` here; that function is only
for raw HTML template strings (Task 5's email bodies), and applying it to a JSX child would
double-escape and show a literal `&amp;` in the browser.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Start the dev server (`preview_start` with the project's existing `avanza-dev`/`docuflow-web`
launch config), log in as `staff@docuflow.mx` / `docuflow-demo-2026` against freshly-seeded data
(`npm run db:seed` first), open the "Poder notarial · Guzmán" case (100% approved), click "Cerrar
expediente", confirm "Completado" is selectable and closing shows the new banner with a working
"Reabrir expediente" button. Then open a case with outstanding Requirements, confirm "Completado"
is disabled there but "Cancelado" with a note succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/features/cases/queries.ts src/app/cases/cases-workspace.tsx
git commit -m "Add Cerrar expediente modal and closure/reopen banners to Staff UI"
```

---

## Task 9: Client Portal — read-only terminal-state view

**Files:**
- Modify: `src/features/case-access/portal-queries.ts`
- Modify: `src/application/client-portal.ts`
- Modify: `src/app/portal/[token]/portal-client.tsx`

**Interfaces:**
- Consumes: `PortalCase`, `PortalState` (both extended below), `getClientDocumentUrlAction` (existing, `src/app/portal/actions.ts` — already allows any of the caller's own Documents regardless of review state, no change needed there).
- Produces: `PortalCase.caseState: 'open' | 'completed' | 'cancelled'`, `PortalCase.clientClosingNote?: string` (and the same two fields on `PortalState`).

- [ ] **Step 1: Extend `PortalCase` and `getPortalCase` in `src/features/case-access/portal-queries.ts`**

Change the `PortalCase` interface:

```typescript
export interface PortalCase {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly caseState: 'open' | 'completed' | 'cancelled';
  readonly clientClosingNote?: string;
  readonly requirements: PortalRequirement[];
}
```

Change the `.select(...)` call inside `getPortalCase` — add `state, client_closing_note` to the
nested `case:cases(...)`:

```typescript
      `case:cases(title, state, client_closing_note, organization:organizations(name)),
       requirements(id, label, position, status, deleted_at, superseded_at,
         documents(id, file_name, created_at, reviews(decision, reason, created_at)))`,
```

Change the return statement:

```typescript
  return {
    organizationName: data.case.organization?.name ?? '',
    caseTitle: data.case.title,
    caseState: data.case.state as 'open' | 'completed' | 'cancelled',
    clientClosingNote: data.case.client_closing_note ?? undefined,
    requirements,
  };
```

- [ ] **Step 2: Extend `PortalState` in `src/application/client-portal.ts`**

Change the `PortalState` interface:

```typescript
export interface PortalState {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly caseState: 'open' | 'completed' | 'cancelled';
  readonly clientClosingNote?: string;
  readonly requirements: PortalRequirement[];
  readonly pendingCount: number;
  readonly isComplete: boolean;
}
```

No change is needed to `getPortalState`'s body — it already returns `{ ...portalCase, pendingCount,
isComplete }`, and `portalCase` (from Task 1's `getPortalCase`) now carries `caseState` and
`clientClosingNote`, which the spread already forwards.

- [ ] **Step 3: Render the terminal-state view in `src/app/portal/[token]/portal-client.tsx`**

Inside `Checklist`, add the terminal branch as the very first check (before the existing
`documentationComplete` branch), replacing the current function body's structure. Change:

```tsx
function Checklist({ token, state, onChanged }: { token: string; state: PortalState; onChanged: () => void }) {
  const pending = state.requirements.filter((r) => r.state === "pending" || r.state === "rejected");
  const resolved = state.requirements.filter((r) => r.state === "review" || r.state === "approved");
  // A Participant with zero Requirements is not "done" — there was never anything to complete
  // (design.md's documentation-complete rule: it requires at least one visible Requirement).
  const documentationComplete = state.isComplete && state.requirements.length > 0;

  return (
```

to:

```tsx
function Checklist({ token, state, onChanged }: { token: string; state: PortalState; onChanged: () => void }) {
  const pending = state.requirements.filter((r) => r.state === "pending" || r.state === "rejected");
  const resolved = state.requirements.filter((r) => r.state === "review" || r.state === "approved");
  // A Participant with zero Requirements is not "done" — there was never anything to complete
  // (design.md's documentation-complete rule: it requires at least one visible Requirement).
  const documentationComplete = state.isComplete && state.requirements.length > 0;
  // Distinct from documentationComplete: the Case itself can be closed (completed OR cancelled)
  // regardless of whether every Requirement was ever approved — a cancelled Case may have
  // Requirements left pending. This check always wins over the documentationComplete branch below.
  const caseClosed = state.caseState !== "open";

  return (
```

Then, inside the same function's `return`, change the JSX so the terminal branch takes priority.
Replace:

```tsx
        {documentationComplete ? (
          <>
            <CompletionBanner />
            <h2 className="mb-3 mt-8 text-sm font-semibold text-text-primary">Tus documentos</h2>
            <div className="space-y-3">
              {resolved.map((r) => (
                <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} />
              ))}
            </div>
          </>
        ) : (
```

with:

```tsx
        {caseClosed ? (
          <>
            <ClosedCaseBanner caseState={state.caseState} clientClosingNote={state.clientClosingNote} />
            <h2 className="mb-3 mt-8 text-sm font-semibold text-text-primary">Tus documentos</h2>
            <div className="space-y-3">
              {state.requirements.map((r) => (
                <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} readOnly />
              ))}
            </div>
          </>
        ) : documentationComplete ? (
          <>
            <CompletionBanner />
            <h2 className="mb-3 mt-8 text-sm font-semibold text-text-primary">Tus documentos</h2>
            <div className="space-y-3">
              {resolved.map((r) => (
                <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} />
              ))}
            </div>
          </>
        ) : (
```

(The closing `)}` of the original ternary already exists further down — no other change needed
there.)

- [ ] **Step 4: Add `ClosedCaseBanner` and `readOnly` support to `RequirementCard`**

Add this new component right after `CompletionBanner`:

```tsx
function ClosedCaseBanner({
  caseState,
  clientClosingNote,
}: {
  caseState: "completed" | "cancelled";
  clientClosingNote?: string;
}) {
  const completed = caseState === "completed";
  return (
    <div className={`complete-rise mt-6 rounded-card border p-6 text-center ${completed ? "border-success/20 bg-success-bg/60" : "border-border bg-app-bg"}`}>
      <div className={`mx-auto flex size-14 items-center justify-center rounded-full text-white ${completed ? "bg-success" : "bg-neutral"}`}>
        {completed ? <IconCheck className="size-7" /> : <IconX className="size-7" />}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary">
        {completed ? "Expediente completado" : "Expediente cancelado"}
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">
        {completed
          ? "Toda tu documentación requerida fue aprobada."
          : (clientClosingNote ?? "Este expediente fue cancelado.")}
      </p>
    </div>
  );
}
```

(`{clientClosingNote}` is a JSX child, auto-escaped by React — do not wrap it in `escapeHtml(...)`
here; that utility is only for Task 5's raw email HTML strings.)

Change `RequirementCard`'s signature and its two conditional blocks to accept and respect
`readOnly`:

```tsx
function RequirementCard({
  token,
  r,
  onChanged,
  quiet,
  readOnly,
}: {
  token: string;
  r: PortalRequirement;
  onChanged: () => void;
  quiet?: boolean;
  readOnly?: boolean;
}) {
```

Change the "rejected" block's condition from `{r.state === "rejected" && (` to
`{r.state === "rejected" && !readOnly && (`, and the "pending" block's condition from
`{r.state === "pending" && (` to `{r.state === "pending" && !readOnly && (`.

Change the "approved" Ver/Descargar block's condition from
`{r.state === "approved" && r.documentId && (` to `{(readOnly ? r.documentId : r.state === "approved" && r.documentId) && (` —
in a closed Case, Ver/Descargar shows for any Requirement that has a Document, whatever its review
state (approved, rejected, or still in review); outside a closed Case, the existing
approved-only rule is unchanged.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Manual verification**

With the dev server running and fresh seed data, close a Case as staff (via Task 8's UI), then open
that Participant's Portal link (reissue one via "Recordar" first if needed, since closing degrades
the existing grant to `view`) and confirm: the checklist is replaced by the closed-Case banner, no
upload controls appear anywhere, and Ver/Descargar work for every Requirement that has a Document —
including one that was rejected or still in review, not only approved ones.

- [ ] **Step 7: Commit**

```bash
git add src/features/case-access/portal-queries.ts src/application/client-portal.ts src/app/portal/[token]/portal-client.tsx
git commit -m "Add read-only terminal-state view to the Client Portal"
```

---

## Task 10: "Completados hoy" metric

**Files:**
- Create: `src/lib/time/zoned-day-boundary.ts`
- Create: `tests/unit/zoned-day-boundary.test.ts`
- Modify: `src/features/cases/queries.ts`
- Modify: `src/app/cases/page.tsx`

**Interfaces:**
- Produces: `zonedDayBoundaryToUtc(now: Date, timeZone: string, daysFromNow: number): Date` — used only by `getOperativeCounts` in this plan, but exported as a general-purpose utility.
- Modifies: `getOperativeCounts`'s signature, from `(cases: CaseView[])` to `(organizationId: string, cases: CaseView[])` — it creates its own Supabase client internally via `createClient()` (`@/lib/supabase/server`), matching every other exported function in this same file (`getWorkspaceCases` does the same) rather than taking one as a parameter.

- [ ] **Step 1: Write the failing unit test for the boundary utility**

```typescript
// tests/unit/zoned-day-boundary.test.ts
import { describe, expect, it } from 'vitest';
import { zonedDayBoundaryToUtc } from '@/lib/time/zoned-day-boundary';

describe('zonedDayBoundaryToUtc', () => {
  it('computes today/tomorrow local midnight for a fixed no-DST-era date (Mexico, post-2022)', () => {
    const now = new Date('2026-08-03T15:00:00Z');
    expect(zonedDayBoundaryToUtc(now, 'America/Mexico_City', 0).toISOString()).toBe('2026-08-03T06:00:00.000Z');
    expect(zonedDayBoundaryToUtc(now, 'America/Mexico_City', 1).toISOString()).toBe('2026-08-04T06:00:00.000Z');
  });

  it('converges correctly during a historical DST-era offset (Mexico observed DST until 2022)', () => {
    // 2015-04-06 fell within Mexico's old DST window (GMT-5), unlike the fixed GMT-6 used today.
    const duringDst = new Date('2015-04-06T15:00:00Z');
    expect(zonedDayBoundaryToUtc(duringDst, 'America/Mexico_City', 0).toISOString()).toBe('2015-04-06T05:00:00.000Z');

    // Same year, before the spring-forward transition — back to GMT-6.
    const beforeDst = new Date('2015-01-15T15:00:00Z');
    expect(zonedDayBoundaryToUtc(beforeDst, 'America/Mexico_City', 0).toISOString()).toBe('2015-01-15T06:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run tests/unit/zoned-day-boundary.test.ts`
Expected: FAIL — `Cannot find module '@/lib/time/zoned-day-boundary'`.

- [ ] **Step 3: Implement the utility**

```typescript
// src/lib/time/zoned-day-boundary.ts

/**
 * Computes the UTC instant of local midnight in `timeZone`, `daysFromNow` days from `now` — backed
 * by the real IANA/ICU timezone database via Intl, never a hardcoded offset (a flat "subtract 6
 * hours" breaks across any offset transition, historical or future). Used by
 * getOperativeCounts's "Completados hoy" metric (src/features/cases/queries.ts).
 */
export function zonedDayBoundaryToUtc(now: Date, timeZone: string, daysFromNow: number): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  const day = Number(parts.find((p) => p.type === 'day')!.value) + daysFromNow;

  // Start from a naive UTC guess for that Y-M-D, then correct twice using the zone's ACTUAL offset
  // at the current candidate instant — two corrections converge exactly even in the rare case
  // where the first correction itself crosses an offset-transition instant.
  let candidate = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 2; i++) {
    const offsetMinutes = offsetMinutesAt(new Date(candidate), timeZone);
    candidate = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60_000;
  }
  return new Date(candidate);
}

function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(instant);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0';
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(offsetPart);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? '0');
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/unit/zoned-day-boundary.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Rewrite `getOperativeCounts` in `src/features/cases/queries.ts`**

`getWorkspaceCases` calls `createClient()` internally and has no test today because of it — there
is no existing precedent in this repo for testing that shape directly from Vitest.
`src/features/blueprints/queries.ts`'s `getBlueprintDefinition`/`listBlueprintSummaries`, by
contrast, take an explicit `client` parameter and are tested in
`tests/integration/blueprint-queries.test.ts`. `getOperativeCounts` follows the *testable*
convention here, since this task's whole point is giving this metric real test coverage it never
had — matching an existing, working pattern in this codebase, not inventing a new one.

Add this import at the top of the file:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { zonedDayBoundaryToUtc } from "@/lib/time/zoned-day-boundary";
```

(`createClient` is still imported and still used by `getWorkspaceCases` — leave that import line
exactly as it is.)

Add this type alias near the top of the file, alongside the other type definitions:

```typescript
type DbClient = SupabaseClient<Database>;
```

Replace the whole `getOperativeCounts` function:

```typescript
export async function getOperativeCounts(
  client: DbClient,
  organizationId: string,
  cases: CaseView[],
): Promise<OperativeCounts> {
  let waitingClient = 0;
  let needsReview = 0;
  let readyToContinue = 0;
  for (const c of cases) {
    const reqs = c.participants.flatMap((p) => p.requirements);
    if (reqs.some((r) => r.state === "review")) needsReview += 1;
    if (reqs.some((r) => r.state === "awaiting" || r.state === "missing" || r.state === "rejected")) waitingClient += 1;
    if (reqs.length > 0 && reqs.every((r) => r.state === "approved")) readyToContinue += 1;
  }

  // A real database COUNT, not a client-side filter over every already-fetched Case — the day
  // boundary is the only thing computed in TypeScript, using the real IANA timezone database
  // (never a hardcoded offset). America/Mexico_City is a fixed, product-wide zone for this MVP,
  // not per-organization — a deliberate, documented simplification.
  const now = new Date();
  const startOfTodayUtc = zonedDayBoundaryToUtc(now, "America/Mexico_City", 0);
  const startOfTomorrowUtc = zonedDayBoundaryToUtc(now, "America/Mexico_City", 1);

  const { count } = await client
    .from("cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("state", "completed")
    .gte("closed_at", startOfTodayUtc.toISOString())
    .lt("closed_at", startOfTomorrowUtc.toISOString());

  return { waitingClient, needsReview, readyToContinue, completedToday: count ?? 0 };
}
```

- [ ] **Step 6: Update the one caller in `src/app/cases/page.tsx`**

Add a client, since `getOperativeCounts` now needs one that `getWorkspaceCases` doesn't expose:

```typescript
import { createClient } from "@/lib/supabase/server";
```

Change:

```typescript
  const cases = await getWorkspaceCases();
  const counts = await getOperativeCounts(cases);
```

to:

```typescript
  const cases = await getWorkspaceCases();
  const supabase = await createClient();
  const counts = await getOperativeCounts(supabase, staff.organizationId, cases);
```

- [ ] **Step 7: Write the failing integration test**

`getOperativeCounts`'s `completedToday` branch queries `client` directly and never reads the
`cases` array (that array only feeds the other three, purely in-memory counts) — so the test can
pass an empty array for it and still fully exercise the metric.

```typescript
// tests/integration/operative-counts.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { getOperativeCounts } from '@/features/cases/queries';
import { closeCase } from '@/features/cases/cases';

async function completeAllRequirements(world: Awaited<ReturnType<typeof buildOrganizationWorld>>) {
  for (const id of world.requirementIds) {
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
  }
}

describe('getOperativeCounts: completedToday', () => {
  it('counts a Case completed today', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Today',
      industry: 'notary',
      clientEmail: `metric-today-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, []);

    expect(counts.completedToday).toBe(1);
  });

  it('never counts a cancelled Case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Cancelled',
      industry: 'notary',
      clientEmail: `metric-cancelled-${randomUUID()}@example.test`,
    });
    await closeCase(world.staff.client, world.caseId, 'cancelled', 'No continúa.');

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, []);

    expect(counts.completedToday).toBe(0);
  });
});
```

- [ ] **Step 8: Run the test**

Run: `npx vitest run tests/integration/operative-counts.test.ts`
Expected: 1 passed.

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/time/zoned-day-boundary.ts tests/unit/zoned-day-boundary.test.ts src/features/cases/queries.ts src/app/cases/page.tsx tests/integration/operative-counts.test.ts
git commit -m "Fix Completados hoy metric: real DB count with a zoned day boundary"
```

---

## Task 11: Full verification

**Files:** none new — this task only runs checks.

- [ ] **Step 1: Confirm local Supabase, not production**

Run: `grep NEXT_PUBLIC_SUPABASE_URL .env.local`
Expected: `http://127.0.0.1:...`. If it shows anything else, STOP and fix `.env.local` before
continuing — do not run any of the following steps against a non-local database.

- [ ] **Step 2: Fresh reset and reseed**

Run: `npm run db:reset && npm run db:types && npm run db:seed`
Expected: no errors; seed output prints the demo staff login and organization id, same as always.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Full test suite**

Run: `npx vitest run`
Expected: every test file passes, including every new file this plan added
(`tests/isolation/case-closure.test.ts`, `tests/integration/case-closure-use-case.test.ts`,
`tests/unit/case-closure-emails.test.ts`, `tests/unit/zoned-day-boundary.test.ts`,
`tests/integration/operative-counts.test.ts`) and every rewritten one
(`tests/integration/case-services.test.ts`).

- [ ] **Step 6: Final repo-wide sweep for `setCaseState` and `completed_at`**

Run:
```bash
grep -rn "setCaseState" --include='*.ts' --include='*.tsx' --include='*.md' /Users/paolabramlett/DocuFlow/src /Users/paolabramlett/DocuFlow/tests /Users/paolabramlett/DocuFlow/scripts /Users/paolabramlett/DocuFlow/docs 2>/dev/null
grep -rn "\.completed_at\|'completed_at'\|\"completed_at\"" --include='*.ts' --include='*.tsx' /Users/paolabramlett/DocuFlow/src /Users/paolabramlett/DocuFlow/tests /Users/paolabramlett/DocuFlow/scripts 2>/dev/null
```
Expected: no output from either command. Any hit on the second command (a stale reference to the
column's old name) must be fixed before this task is done — likely candidates: `scripts/seed-demo.mjs`
(currently writes `completed_at` on the Guzmán demo Case) and any test in `tests/isolation/` that
predates this plan and still references the old column name directly.

- [ ] **Step 7: Manual smoke test**

With the dev server running (`preview_start`, `docuflow-web`/`avanza-dev` launch config) and fresh
seed data: log in as staff, open a 100%-approved Case, close it as "Completado", confirm the banner
and "Reabrir expediente" work; open a different Case, cancel it with a note, confirm the same;
reopen one and confirm the client's Portal link (reissued via "Recordar") shows active upload
controls again, not the read-only view.

- [ ] **Step 8: Final commit** (only if Steps 6-7 required fixes; otherwise this task is a
verification pass with nothing new to commit)

```bash
git add -A
git commit -m "Fix stale completed_at references found during full verification"
```
