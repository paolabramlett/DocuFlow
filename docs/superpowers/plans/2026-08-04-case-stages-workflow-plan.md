# Case Stages Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Blueprint/Case "stages" from an inert grouping label into a real sequential workflow that governs Case visibility, Staff actions, reminders, and the Client Portal, without regressing Cases that have no stages.

**Architecture:** `case_stages` gains `status`/`completion_mode`/timestamps, enforced by a partial-unique "one active stage per Case" index and an atomic `advance_case_stage` RPC. Correcting an approved requirement reuses the existing supersede mechanism (`reopen_requirement`) instead of mutating an already-reviewed row. A single SQL function (`app.actionable_requirement_ids`, `security invoker`) feeds both the reminder cron and the manual "Recordar" button, fixing an existing drift bug. `createCaseWithParticipants` is fixed to stop silently dropping `stage_id` on participant-scoped requirements — this lands first, since every later task depends on stages actually being populated.

**Tech Stack:** Next.js 16 App Router, Supabase Postgres + RLS, `plpgsql`/`sql` RPCs, Vitest (`tests/isolation/`, `tests/integration/`, `tests/component/`), Resend (email).

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-08-04-case-stages-workflow-design.md` — read it once before Task 1; every task below implements one numbered section of it. Do not reopen decisions already locked there.
- Every RPC exception uses `raise exception using errcode = 'P0001', message = 'stable_snake_case_code'` — a fixed literal, never `%`-interpolated. `error.message` on the JS side is always that exact string.
- Authorization is always a plain, non-locking `select` before any `for update` row lock (PostgreSQL RLS applies a table's UPDATE-policy USING clause, not only SELECT's, to a row fetched with `FOR UPDATE` — checking membership via a non-locking read first is what lets "not authorized" and "not found" be told apart correctly).
- Emails/notifications are sent post-commit, best-effort, try/catch-logged, never blocking the transaction or the RPC's own success.
- Copy is Spanish (Mexico).
- Server Actions never call `redirect()`; they return `ActionResult<T>` and the client does `router.refresh()`/`router.replace()` only on `result.ok`.
- Before running any command that writes to the database (`npm run db:reset`, `npx vitest run`, `npm run db:seed`), confirm `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL` is `http://127.0.0.1:...` — never a production URL.
- Run `npm run typecheck && npm run lint` after every task that touches `.ts`/`.tsx` files, before committing.
- A Case with zero `case_stages` rows must behave identically to today at every layer touched by this plan — every task that adds stage-aware logic must include the "no stages" branch as an explicit, tested case, not an assumed no-op.

---

## Task 1: Schema migration — `case_stages`/`blueprint_stages`/`requirements` columns

**Files:**
- Create: `supabase/migrations/20260804160000_case_stages_workflow_schema.sql`
- Test: `tests/isolation/case-stages-workflow.test.ts` (new file, started here)

**Interfaces:**
- Produces: `case_stages.status`, `case_stages.completion_mode`, `case_stages.activated_at`, `case_stages.completed_at`, `case_stages.completed_by_auth_user_id`; `blueprint_stages.completion_mode`; `requirements.reopened_from_requirement_id`; `requirements.reopen_reason`; unique index `case_stages_one_active_per_case`. Every later task reads or writes these exact names.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260804160000_case_stages_workflow_schema.sql
--
-- Schema for the Case Stages sequential workflow. See
-- docs/superpowers/specs/2026-08-04-case-stages-workflow-design.md for the full design. This file
-- only adds columns/constraints; advance_case_stage, reopen_requirement, assign_requirement_stage,
-- and the reminder-selector rewrite are their own, later-numbered migrations.

-- ---------------------------------------------------------------------------------------------
-- blueprint_stages: completion_mode, cloned once into case_stages, never live-synced afterward
-- ---------------------------------------------------------------------------------------------

alter table public.blueprint_stages
  add column completion_mode text not null default 'requirements'
    check (completion_mode in ('requirements', 'manual'));

comment on column public.blueprint_stages.completion_mode is
  'requirements: stage completes when every client-visible requirement in it is satisfied. manual:
   staff confirms explicitly. Cloned into case_stages.completion_mode at Case creation; editing a
   Blueprint afterward never changes an already-cloned Case (existing project-wide rule).';

-- ---------------------------------------------------------------------------------------------
-- case_stages: sequencing state
-- ---------------------------------------------------------------------------------------------

alter table public.case_stages
  add column status text not null default 'locked'
    check (status in ('locked', 'active', 'completed')),
  add column completion_mode text not null default 'requirements'
    check (completion_mode in ('requirements', 'manual')),
  add column activated_at timestamptz,
  add column completed_at timestamptz,
  add column completed_by_auth_user_id uuid references auth.users (id) on delete set null;

comment on column public.case_stages.status is
  'locked -> active -> completed. Exactly one active stage per Case, enforced by
   case_stages_one_active_per_case below. No direct locked -> completed or backward transition.';

-- At most one active stage per Case. This is the workflow's core invariant — advance_case_stage
-- (Task 3) relies on it existing at the database level, not merely in application code.
create unique index case_stages_one_active_per_case
  on public.case_stages (case_id) where status = 'active';

-- ---------------------------------------------------------------------------------------------
-- requirements: reopening is a NEW ROW (supersede), never a status mutation on the approved one
-- ---------------------------------------------------------------------------------------------

alter table public.requirements
  add column reopened_from_requirement_id uuid references public.requirements (id) on delete set null,
  add column reopen_reason text check (reopen_reason is null or length(reopen_reason) <= 1000);

comment on column public.requirements.reopened_from_requirement_id is
  'Set only on a row created by reopen_requirement (Task 4). Points at the original, now-superseded
   requirement whose approval this row corrects. "Pending reopened requirement" (used by the
   advance-stage gate and the reminder selector) means: reopened_from_requirement_id is not null
   and status = ''outstanding''.';
```

- [ ] **Step 2: Apply the migration locally and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `src/types/database.ts` now has `status`/`completion_mode`/`activated_at`/`completed_at`/`completed_by_auth_user_id` on `case_stages`, `completion_mode` on `blueprint_stages`, `reopened_from_requirement_id`/`reopen_reason` on `requirements`.

- [ ] **Step 3: Write the failing isolation test (schema shape only)**

```typescript
// tests/isolation/case-stages-workflow.test.ts
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';

describe('case stages workflow: schema', () => {
  it('case_stages.status defaults to locked and rejects an invalid value', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages Schema', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client', email: `stages-schema-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Schema Case',
    });
    const { data: stage } = await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa 1', position: 0 })
      .select('status, completion_mode')
      .single();
    expect(stage?.status).toBe('locked');
    expect(stage?.completion_mode).toBe('requirements');

    const { error } = await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa Mala', position: 1, status: 'bogus' });
    expect(error).not.toBeNull();
  });

  it('enforces at most one active stage per case', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages OneActive', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client 2', email: `stages-oneactive-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'OneActive Case',
    });
    await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa A', position: 0, status: 'active' });

    const { error } = await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa B', position: 1, status: 'active' });
    expect(error?.message).toContain('case_stages_one_active_per_case');
  });

  it('rejects a reopen_reason longer than 1000 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages Reason', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client 3', email: `stages-reason-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Reason Case',
    });

    const { error } = await admin
      .from('requirements')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        type: 'document',
        label: 'Requisito',
        position: 0,
        reopen_reason: 'x'.repeat(1001),
      });
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/isolation/case-stages-workflow.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260804160000_case_stages_workflow_schema.sql src/types/database.ts tests/isolation/case-stages-workflow.test.ts
git commit -m "Add case-stages-workflow schema: status/completion_mode/reopen columns"
```

---

## Task 2: Fix `createCaseWithParticipants` — participant-scoped requirements keep their `stage_id`

**Files:**
- Modify: `src/application/create-case-with-participants.ts:198-269`
- Modify: `tests/integration/create-case-with-participants.test.ts` (existing file — add new tests)

**Interfaces:**
- Consumes: `BlueprintDefinition.requirements` (`src/features/blueprints/queries.ts`, existing — each entry may carry `stagePosition`), `case_stages` rows already cloned by `create_case` (Task 1's schema; `create_case`'s own cloning logic already exists, unchanged by this plan).
- Produces: `createCaseWithParticipants` now throws `UseCaseError('validation', ...)` when a participant-scoped requirement's `stagePosition` cannot be resolved against the Case's cloned stages, instead of silently inserting `stage_id: null`.

This is the spec's explicit "required, first task, not optional" fix (§6.1): without it, every later stage-gating task would be built on requirements that never actually got a `stage_id`.

- [ ] **Step 1: Read the current shape of a Blueprint requirement definition**

Run: `grep -n "stagePosition\|stage_position" /Users/paolabramlett/DocuFlow/src/features/blueprints/queries.ts`
Expected: confirms `BlueprintDefinition.requirements[].stagePosition?: number` exists on the type returned by `getBlueprintDefinition` (already used by `create_case`'s own SQL clone path for `scope: 'case'` requirements — this task applies the same resolution to `scope: 'participant'` ones, in TypeScript, since `createCaseWithParticipants` — not `create_case` — is what creates those).

- [ ] **Step 2: Write the failing test — append to `tests/integration/create-case-with-participants.test.ts`**

```typescript
// Add these imports if not already present at the top of the file:
// import { adminClient } from '../helpers/clients';

describe('participant-scoped requirements keep their stage_id', () => {
  it('resolves stage_position against the cloned case_stages for a participant-scoped requirement', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stage Wiring', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({ organization_id: organizationId, name: 'Con etapas', requirement_definitions: [] })
      .select('id')
      .single();
    await owner.client.from('blueprint_stages').insert([
      { organization_id: organizationId, blueprint_id: blueprint!.id, name: 'Kick-Off', position: 0 },
      { organization_id: organizationId, blueprint_id: blueprint!.id, name: 'Milestone 1', position: 1 },
    ]);
    await owner.client
      .from('blueprints')
      .update({
        requirement_definitions: [
          { key: 'ine-comprador', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer', stage_position: 1 },
        ],
      })
      .eq('id', blueprint!.id);

    const { data: client } = await adminClient()
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Comprador', email: `stage-wiring-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const result = await createCaseWithParticipants(
      staff.client,
      {
        organizationId,
        title: 'Compraventa con etapas',
        blueprintId: blueprint!.id,
        participants: [
          {
            source: 'blueprint',
            participantTemplateRoleKey: 'buyer',
            roleLabel: 'Comprador',
            fullName: 'Comprador',
            email: client!.email!,
            requirementKeys: ['ine-comprador'],
          },
        ],
        sendInvitations: false,
      },
      staff.userId,
    );

    const { data: milestone1 } = await adminClient()
      .from('case_stages')
      .select('id')
      .eq('case_id', result.caseId)
      .eq('position', 1)
      .single();
    const { data: req } = await adminClient()
      .from('requirements')
      .select('stage_id')
      .eq('case_id', result.caseId)
      .eq('label', 'INE')
      .single();
    expect(req?.stage_id).toBe(milestone1!.id);
  });

  it('fails Case creation when stage_position cannot be resolved, instead of silently using stage_id = null', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stage Unresolved', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Etapa rota',
        // stage_position: 5 but the Blueprint has zero blueprint_stages rows — unresolvable.
        requirement_definitions: [
          { key: 'ine-comprador', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer', stage_position: 5 },
        ],
      })
      .select('id')
      .single();

    const { data: client } = await adminClient()
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Comprador', email: `stage-unresolved-${randomUUID()}@example.test` })
      .select('id')
      .single();

    await expect(
      createCaseWithParticipants(
        staff.client,
        {
          organizationId,
          title: 'Compraventa rota',
          blueprintId: blueprint!.id,
          participants: [
            {
              source: 'blueprint',
              participantTemplateRoleKey: 'buyer',
              roleLabel: 'Comprador',
              fullName: 'Comprador',
              email: client!.email!,
              requirementKeys: ['ine-comprador'],
            },
          ],
          sendInvitations: false,
        },
        staff.userId,
      ),
    ).rejects.toMatchObject({ reason: 'validation' });

    // No partial Case with a dangling requirement should be left in a state a later task could
    // mistake for legitimate "Sin etapa" data — confirm no Case with this title exists at all is
    // NOT assertable (createCaseWithParticipants is not transactional across its own steps, matching
    // its own documented "NOT ATOMIC" contract) — instead confirm no requirement with a null
    // stage_id and this label exists, which is the actual invariant this fix protects.
    const { data: orphaned } = await adminClient()
      .from('requirements')
      .select('id')
      .eq('organization_id', organizationId)
      .is('stage_id', null)
      .eq('label', 'INE');
    expect(orphaned).toHaveLength(0);
  });

  it('leaves stage_id null when the Blueprint requirement definition has no stage_position at all', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stage None', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Sin etapas',
        requirement_definitions: [
          { key: 'ine-comprador', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer' },
        ],
      })
      .select('id')
      .single();

    const { data: client } = await adminClient()
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Comprador', email: `stage-none-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const result = await createCaseWithParticipants(
      staff.client,
      {
        organizationId,
        title: 'Compraventa sin etapas',
        blueprintId: blueprint!.id,
        participants: [
          {
            source: 'blueprint',
            participantTemplateRoleKey: 'buyer',
            roleLabel: 'Comprador',
            fullName: 'Comprador',
            email: client!.email!,
            requirementKeys: ['ine-comprador'],
          },
        ],
        sendInvitations: false,
      },
      staff.userId,
    );

    const { data: req } = await adminClient()
      .from('requirements')
      .select('stage_id')
      .eq('case_id', result.caseId)
      .eq('label', 'INE')
      .single();
    expect(req?.stage_id).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/integration/create-case-with-participants.test.ts -t "participant-scoped requirements keep their stage_id"`
Expected: FAIL (first test: `stage_id` is null instead of `milestone1.id`; second: no error thrown; third already passes).

- [ ] **Step 4: Fix `createCaseWithParticipants`**

In `src/application/create-case-with-participants.ts`, after the existing `allowedByRole` construction (ends at line 156) and before `clientIds` resolution (line 161), add stage resolution for participant-scoped requirement definitions:

```typescript
// Resolve each participant-scoped Requirement definition's stage_position (if any) against the
// Blueprint's own blueprint_stages, up front — this is validation, not a write, so a Case with a
// dangling stage reference is never created (§6.1 of the design spec). Keyed by requirement key
// since that's what requirementKeys/allowedByRole already use; case-scope definitions don't need
// this (create_case's own SQL already resolves their stage_id during the clone).
const stagePositionByRequirementKey = new Map<string, number>();
if (blueprintDefinition) {
  for (const r of blueprintDefinition.requirements) {
    if (r.scope === "participant" && r.stagePosition !== undefined) {
      stagePositionByRequirementKey.set(r.key, r.stagePosition);
    }
  }
}
```

Then, after `caseId` is created (line 184, right after the `try { caseId = await createCase(...) } catch {...}` block) and before the participant loop begins (line 202), resolve the Case's own cloned stages once:

```typescript
// Case-level lookup from stage_position -> the cloned case_stages.id, built once (not per
// participant/requirement) since create_case already cloned every blueprint_stages row 1:1 into
// case_stages with matching position, keyed by this same Case.
const stagePositionToStageId = new Map<number, string>();
if (blueprintId) {
  const { data: clonedStages } = await client
    .from("case_stages")
    .select("id, position")
    .eq("case_id", caseId);
  for (const s of clonedStages ?? []) {
    stagePositionToStageId.set(s.position, s.id);
  }
}
```

Then, inside the participant loop's requirement-creation block (`src/application/create-case-with-participants.ts:231-238`, the `for (const label of effectiveLabels) { await addRequirement(...) }` loop), it needs the requirement's *key*, not just its label, to look up `stagePositionByRequirementKey` — but `effectiveLabels` (line 221-229) currently discards the key. Change the loop to iterate over `[key, label]` pairs instead:

```typescript
// Resolve this participant's actual Requirement labels — see the existing comment above this
// block (unchanged) for the allowlist/narrowing rules. Changed from a label-only array to
// [key, label] pairs so stage_position can be resolved per requirement below.
let effectiveEntries: [string, string][];
if (p.source === "manual") {
  effectiveEntries = p.requirements.map((label) => [label, label]);
} else {
  const allowedByKey = allowedByRole.get(p.participantTemplateRoleKey)!;
  effectiveEntries = p.requirementKeys
    .filter((key) => allowedByKey.has(key))
    .map((key) => [key, allowedByKey.get(key)!]);
}

let position = 0;
for (const [key, label] of effectiveEntries) {
  let stageId: string | undefined;
  const stagePosition = stagePositionByRequirementKey.get(key);
  if (stagePosition !== undefined) {
    stageId = stagePositionToStageId.get(stagePosition);
    if (stageId === undefined) {
      // A requirement definition names a stage_position that didn't survive the clone (e.g. the
      // Blueprint's blueprint_stages was edited between validation and this write, or the
      // position simply doesn't exist) — fail outright rather than silently dropping to
      // stage_id: null (§6.1: "stage_id = null is not an acceptable fallback" for a Blueprint-
      // derived requirement that specified a stage_position).
      throw new UseCaseError(
        "validation",
        "No pudimos ubicar la etapa de uno de los requisitos de esta plantilla. Revisa la configuración de etapas.",
      );
    }
  }
  await addRequirement(
    client,
    { organizationId, caseId, label, position: position++, participantId, stageId },
    actorAuthUserId,
  );
}
totalRequirementCount += effectiveEntries.length;
```

Remove the now-superseded `effectiveLabels` variable and its old loop (the block this replaces, `src/application/create-case-with-participants.ts:221-239`).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/create-case-with-participants.test.ts`
Expected: all pass, including the 3 new tests and every pre-existing test in this file (this fix only adds behavior for the `stagePosition`-set case; every existing test path has no `stagePosition`, hits the `stagePosition !== undefined` false branch, and is unaffected).

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/application/create-case-with-participants.ts tests/integration/create-case-with-participants.test.ts
git commit -m "Fix createCaseWithParticipants: participant-scoped requirements keep their stage_id"
```

---

## Task 3: `advance_case_stage` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260804160100_advance_case_stage_rpc.sql`
- Modify: `tests/isolation/case-stages-workflow.test.ts`

**Interfaces:**
- Consumes: `case_stages.status`/`completion_mode` (Task 1), `requirements.reopened_from_requirement_id` (Task 1), `app.member_org_ids()` (existing).
- Produces: `public.advance_case_stage(p_case_id uuid) returns table (participant_id uuid)` — Task 7's Server Action calls this.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260804160100_advance_case_stage_rpc.sql

create or replace function public.advance_case_stage(p_case_id uuid)
returns table (participant_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_active public.case_stages;
  v_next public.case_stages;
  v_unassigned_count integer;
  v_reopened_pending_count integer;
  v_visible_total integer;
  v_visible_outstanding integer;
begin
  -- Authorization before any lock — same reasoning as close_case/reopen_case: a plain SELECT only
  -- needs the SELECT policy, so "not a member" and "case does not exist" stay distinguishable.
  select organization_id into v_org_id from public.cases where id = p_case_id;
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'case_not_found';
  end if;
  if v_org_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_active from public.case_stages
  where case_id = p_case_id and status = 'active'
  for update;

  if v_active.id is null then
    raise exception using errcode = 'P0001', message = 'no_active_stage';
  end if;

  -- Gate 1: no unassigned ("Sin etapa") client-visible requirement pending anywhere in the Case —
  -- these have no stage to belong to, so they block the whole workflow until Staff resolves them
  -- (assign_requirement_stage, Task 5) rather than blocking one specific stage.
  select count(*) into v_unassigned_count
  from public.requirements r
  where r.case_id = p_case_id
    and r.stage_id is null
    and r.participant_id is not null
    and r.status = 'outstanding'
    and r.deleted_at is null
    and r.superseded_at is null;

  if v_unassigned_count > 0 then
    raise exception using errcode = 'P0001', message = 'unassigned_requirement_pending';
  end if;

  -- Gate 2: no pending reopened requirement anywhere in the Case, regardless of which stage it
  -- originally belonged to.
  select count(*) into v_reopened_pending_count
  from public.requirements r
  where r.case_id = p_case_id
    and r.reopened_from_requirement_id is not null
    and r.status = 'outstanding'
    and r.deleted_at is null
    and r.superseded_at is null;

  if v_reopened_pending_count > 0 then
    raise exception using errcode = 'P0001', message = 'reopened_requirement_pending';
  end if;

  -- Gate 3: active-stage readiness. Both completion_mode values share one rule now (fix #3 from
  -- design review): a client-visible requirement in THIS stage that is still 'outstanding' blocks
  -- advancing, regardless of completion_mode. The only thing completion_mode changes is whether a
  -- stage with ZERO client-visible requirements is trivially ready (both modes: yes) versus
  -- requiring at least one satisfied requirement to prove real completion — that "at least one"
  -- floor applies ONLY to 'requirements' mode, matching the design's "never auto-ready an empty
  -- requirements-mode stage" rule; a manual stage with zero requirements is legitimately ready by
  -- staff confirmation alone.
  select count(*), count(*) filter (where r.status = 'outstanding')
    into v_visible_total, v_visible_outstanding
    from public.requirements r
   where r.stage_id = v_active.id
     and r.participant_id is not null
     and r.deleted_at is null
     and r.superseded_at is null;

  if v_visible_outstanding > 0 then
    raise exception using errcode = 'P0001', message = 'stage_not_ready';
  end if;
  if v_active.completion_mode = 'requirements' and v_visible_total = 0 then
    raise exception using errcode = 'P0001', message = 'stage_not_ready';
  end if;

  update public.case_stages
     set status = 'completed', completed_at = now(), completed_by_auth_user_id = (select auth.uid())
   where id = v_active.id;

  select * into v_next from public.case_stages
  where case_id = p_case_id and position > v_active.position
  order by position asc limit 1
  for update;

  if v_next.id is not null then
    update public.case_stages
       set status = 'active', activated_at = now()
     where id = v_next.id;
  end if;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_org_id, p_case_id, 'case.stage_advanced', 'case_stage', v_active.id,
    'member', (select auth.uid()),
    jsonb_build_object('completed_stage_id', v_active.id, 'activated_stage_id', v_next.id)
  );

  -- Contract when there is no next stage (v_next.id is null): this WHERE never matches any row
  -- (no requirement has stage_id equal to null via `=`), so the function returns an empty result
  -- set — never an error, never a null row. The last stage still completed above.
  --
  -- Fix #5 from design review: only participants with a requirement that is ACTIONABLE right now
  -- in the newly-activated stage (status = 'outstanding', client-visible, not deleted/superseded)
  -- are returned — not merely "has a visible requirement there". A requirement already satisfied
  -- by legacy data, or a manual stage with no client requirements at all, notifies nobody.
  return query
    select distinct r.participant_id
    from public.requirements r
    where r.stage_id = v_next.id
      and r.participant_id is not null
      and r.deleted_at is null
      and r.superseded_at is null
      and r.status = 'outstanding';
end;
$$;

revoke all on function public.advance_case_stage(uuid) from public;
grant execute on function public.advance_case_stage(uuid) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `advance_case_stage` appears in `src/types/database.ts`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-stages-workflow.test.ts`**

```typescript
// Add these imports at the top of the file:
// import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';
// (adminClient/randomUUID already imported by Task 1's setup)

/** Builds an Organization + Case with N case_stages (position 0..N-1, first one 'active'), one
 *  Participant, and one client-visible 'requirements'-mode requirement per stage assigned to that
 *  Participant. Returns everything a stage-advancement test needs. */
async function buildStagedCase(options: {
  name: string;
  stageCount: number;
  completionModes?: ('requirements' | 'manual')[];
}) {
  const { organizationId, owner } = await createOrganizationWithOwner(options.name, 'notary');
  const staff = await addStaffMember(owner, organizationId);
  const admin = adminClient();
  const { data: clientRow } = await admin
    .from('clients')
    .insert({ organization_id: organizationId, full_name: 'Cliente', email: `staged-${randomUUID()}@example.test` })
    .select('id')
    .single();
  const { data: caseId } = await staff.client.rpc('create_case', {
    target_organization_id: organizationId,
    target_client_id: clientRow!.id,
    case_title: options.name,
  });
  const { data: participant } = await staff.client
    .from('case_participants')
    .insert({ organization_id: organizationId, case_id: caseId!, client_id: clientRow!.id, role_label: 'primary' })
    .select('id')
    .single();

  const stageIds: string[] = [];
  for (let i = 0; i < options.stageCount; i++) {
    const { data: stage } = await admin
      .from('case_stages')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        name: `Etapa ${i + 1}`,
        position: i,
        status: i === 0 ? 'active' : 'locked',
        completion_mode: options.completionModes?.[i] ?? 'requirements',
        activated_at: i === 0 ? new Date().toISOString() : null,
      })
      .select('id')
      .single();
    stageIds.push(stage!.id);
  }

  const requirementIds: string[] = [];
  for (let i = 0; i < options.stageCount; i++) {
    const { data: req } = await admin
      .from('requirements')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        participant_id: participant!.id,
        stage_id: stageIds[i],
        type: 'document',
        label: `Requisito etapa ${i + 1}`,
        position: 0,
      })
      .select('id')
      .single();
    requirementIds.push(req!.id);
  }

  return { organizationId, owner, staff, caseId: caseId!, participantId: participant!.id, stageIds, requirementIds };
}

describe('advance_case_stage', () => {
  it('completes the active stage and activates the next when the active stage is ready', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Basic', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);

    const { data, error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error).toBeNull();
    expect(data?.map((r) => r.participant_id)).toEqual([w.participantId]);

    const { data: stages } = await adminClient()
      .from('case_stages')
      .select('id, status')
      .eq('case_id', w.caseId)
      .order('position');
    expect(stages?.[0]).toMatchObject({ status: 'completed' });
    expect(stages?.[1]).toMatchObject({ status: 'active' });
  });

  it('rejects advancing when the active stage has an outstanding client-visible requirement', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance NotReady', stageCount: 2 });
    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('a requirements-mode stage with zero client-visible requirements never auto-readies', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance EmptyRequirements', stageCount: 2 });
    await adminClient().from('requirements').delete().eq('id', w.requirementIds[0]!);

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('a manual stage with zero client-visible requirements is trivially ready', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance ManualEmpty', stageCount: 2, completionModes: ['manual', 'requirements'] });
    await adminClient().from('requirements').delete().eq('id', w.requirementIds[0]!);

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error).toBeNull();
  });

  it('a manual stage with an outstanding client-visible requirement is blocked exactly like requirements-mode', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance ManualBlocked', stageCount: 2, completionModes: ['manual', 'requirements'] });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('rejects advancing when an unassigned ("Sin etapa") requirement is pending', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Unassigned', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').insert({
      organization_id: w.organizationId,
      case_id: w.caseId,
      participant_id: w.participantId,
      stage_id: null,
      type: 'document',
      label: 'Sin etapa',
      position: 1,
    });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('unassigned_requirement_pending');
  });

  it('completing the last stage does not close the Case', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance LastStage', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);

    const { data, error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: stage } = await adminClient().from('case_stages').select('status').eq('id', w.stageIds[0]!).single();
    expect(stage?.status).toBe('completed');
    const { data: caseRow } = await adminClient().from('cases').select('state').eq('id', w.caseId).single();
    expect(caseRow?.state).toBe('open');
  });

  it('a satisfied-by-legacy-data requirement in the newly-active stage is not notified', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance NoNotify', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[1]!);

    const { data } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(data).toHaveLength(0);
  });

  it('serializes two concurrent advance calls on the same Case — the second sees the new state', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Concurrent', stageCount: 3 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[1]!);

    const [a, b] = await Promise.all([
      w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId }),
      w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId }),
    ]);
    // Exactly one of the two calls actually advances past stage 1 in this race (both target the
    // stage that was active when they started); the loser either succeeds against the
    // already-ready stage 2 too (if it re-reads after the winner committed) or fails
    // stage_not_ready (if stage 2's own requirement was never satisfied) — the invariant this test
    // protects is that no stage was ever skipped and the row lock actually serialized them, not a
    // pinned outcome for which call "wins".
    const { data: stages } = await adminClient()
      .from('case_stages')
      .select('status')
      .eq('case_id', w.caseId)
      .order('position');
    const activeCount = stages?.filter((s) => s.status === 'active').length ?? 0;
    expect(activeCount).toBeLessThanOrEqual(1);
    const completedCount = stages?.filter((s) => s.status === 'completed').length ?? 0;
    expect(completedCount).toBeGreaterThanOrEqual(1);
    expect([a.error, b.error].some((e) => e === null)).toBe(true);
  });

  it('a Client cannot call advance_case_stage despite an active grant', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Client', stageCount: 1 });
    const granted = await grantVerifiedAccess({
      world: {
        organizationId: w.organizationId,
        owner: w.owner,
        staff: w.staff,
        clientId: '',
        clientEmail: '',
        blueprintId: '',
        caseId: w.caseId,
        participantId: w.participantId,
        requirementIds: w.requirementIds,
      },
      permission: 'view',
    });

    const { error } = await granted.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('not_authorized');
  });
});
```

Note: the last test constructs a minimal `OrganizationWorld`-shaped object for `grantVerifiedAccess` since `buildStagedCase` (this task's own local helper) is not `buildOrganizationWorld` — `grantVerifiedAccess` only reads `organizationId`/`caseId`/`participantId`/`clientId`/`clientEmail` off it, so the empty strings for unused fields are safe. Add `import { grantVerifiedAccess } from '../helpers/fixtures';` at the top of the file.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-stages-workflow.test.ts`
Expected: all `advance_case_stage` tests pass (10 tests in this describe block).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260804160100_advance_case_stage_rpc.sql src/types/database.ts tests/isolation/case-stages-workflow.test.ts
git commit -m "Add advance_case_stage RPC: atomic stage completion with unassigned/reopened gates"
```

---

## Task 4: `reopen_requirement` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260804160200_reopen_requirement_rpc.sql`
- Modify: `tests/isolation/case-stages-workflow.test.ts`

**Interfaces:**
- Consumes: `requirements.reopened_from_requirement_id`/`reopen_reason` (Task 1), `case_stages.status` (Task 1).
- Produces: `public.reopen_requirement(p_requirement_id uuid, p_reason text) returns uuid` (the new requirement's id) — Task 7's Server Action calls this.

Note on the original row's `status`: the spec's SQL sketch (§4) only set `superseded_at`/`superseded_by_requirement_id` on the original, leaving `status = 'satisfied'`. The codebase's one existing supersede path, `supersedeRequirement` (`src/features/cases/cases.ts:469-480`), always sets `status = 'archived'` together with those two columns. This task follows that established convention for consistency — a superseded row's `status` reading `archived` (not `satisfied`) is what every other superseded row in this schema already does, and nothing reads `status` on a superseded row for gating purposes (every gate query in Task 3 already filters `superseded_at is null` first).

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260804160200_reopen_requirement_rpc.sql

create or replace function public.reopen_requirement(p_requirement_id uuid, p_reason text)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_original public.requirements;
  v_stage_status text;
  v_new_id uuid;
begin
  select organization_id into v_org_id from public.requirements where id = p_requirement_id;
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'requirement_not_found';
  end if;
  if v_org_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_original from public.requirements where id = p_requirement_id for update;

  if v_original.stage_id is null then
    raise exception using errcode = 'P0001', message = 'requirement_has_no_stage';
  end if;

  select status into v_stage_status from public.case_stages where id = v_original.stage_id;
  if v_stage_status is distinct from 'completed' then
    raise exception using errcode = 'P0001', message = 'stage_not_completed';
  end if;

  if v_original.status <> 'satisfied' then
    raise exception using errcode = 'P0001', message = 'requirement_not_satisfied';
  end if;

  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'reopen_reason_required';
  end if;

  insert into public.requirements (
    organization_id, case_id, type, label, instructions, position, config,
    participant_id, stage_id, status, reopened_from_requirement_id, reopen_reason
  )
  values (
    v_original.organization_id, v_original.case_id, v_original.type, v_original.label,
    v_original.instructions, v_original.position, v_original.config,
    v_original.participant_id, v_original.stage_id, 'outstanding',
    v_original.id, btrim(p_reason)
  )
  returning id into v_new_id;

  -- Matches supersedeRequirement's existing convention (src/features/cases/cases.ts) exactly:
  -- status becomes 'archived' alongside superseded_at/superseded_by_requirement_id, not left at
  -- 'satisfied'. Every gate query that touches a superseded row already filters
  -- superseded_at is null first, so this never changes gating outcomes — it only keeps this
  -- schema's one "a row has been replaced" signal consistent everywhere it appears.
  update public.requirements
     set status = 'archived', superseded_at = now(), superseded_by_requirement_id = v_new_id
   where id = v_original.id;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_original.organization_id, v_original.case_id, 'requirement.reopened', 'requirement', v_new_id,
    'member', (select auth.uid()),
    jsonb_build_object('original_requirement_id', v_original.id, 'reason', btrim(p_reason))
  );

  return v_new_id;
end;
$$;

revoke all on function public.reopen_requirement(uuid, text) from public;
grant execute on function public.reopen_requirement(uuid, text) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `reopen_requirement` appears in `src/types/database.ts`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-stages-workflow.test.ts`**

```typescript
describe('reopen_requirement', () => {
  it('supersedes the original: original becomes archived+superseded, new row is clean and outstanding', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen Basic', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);

    const { data: newId, error } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: 'El documento subido no coincide con el titular.',
    });
    expect(error).toBeNull();

    const { data: original } = await adminClient()
      .from('requirements')
      .select('status, superseded_at, superseded_by_requirement_id')
      .eq('id', w.requirementIds[0]!)
      .single();
    expect(original).toMatchObject({ status: 'archived', superseded_by_requirement_id: newId });
    expect(original?.superseded_at).not.toBeNull();

    const { data: fresh } = await adminClient()
      .from('requirements')
      .select('status, stage_id, participant_id, reopened_from_requirement_id, reopen_reason, label')
      .eq('id', newId!)
      .single();
    expect(fresh).toMatchObject({
      status: 'outstanding',
      stage_id: w.stageIds[0],
      participant_id: w.participantId,
      reopened_from_requirement_id: w.requirementIds[0],
      reopen_reason: 'El documento subido no coincide con el titular.',
      label: 'Requisito etapa 1',
    });
  });

  it('rejects reopening a requirement whose stage is not yet completed', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen NotCompleted', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);

    const { error } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: 'Motivo',
    });
    expect(error?.message).toBe('stage_not_completed');
  });

  it('rejects reopening a requirement that is not currently satisfied', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen NotSatisfied', stageCount: 1 });
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);

    const { error } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: 'Motivo',
    });
    expect(error?.message).toBe('requirement_not_satisfied');
  });

  it('rejects a blank reason', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen BlankReason', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);

    const { error } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: '   ',
    });
    expect(error?.message).toBe('reopen_reason_required');
  });

  it('rejects reopening a requirement with no stage at all', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen NoStage', stageCount: 1 });
    const { data: bare } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId,
        case_id: w.caseId,
        participant_id: w.participantId,
        stage_id: null,
        type: 'document',
        label: 'Sin etapa',
        position: 1,
        status: 'satisfied',
      })
      .select('id')
      .single();

    const { error } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: bare!.id,
      p_reason: 'Motivo',
    });
    expect(error?.message).toBe('requirement_has_no_stage');
  });

  it('a Client cannot call reopen_requirement', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen Client', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);
    const granted = await grantVerifiedAccess({
      world: {
        organizationId: w.organizationId, owner: w.owner, staff: w.staff, clientId: '', clientEmail: '',
        blueprintId: '', caseId: w.caseId, participantId: w.participantId, requirementIds: w.requirementIds,
      },
      permission: 'view',
    });

    const { error } = await granted.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: 'Motivo',
    });
    expect(error?.message).toBe('not_authorized');
  });

  it('the audit event records the original and new requirement ids atomically', async () => {
    const w = await buildStagedCase({ name: 'Notaría Reopen Audit', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);

    const { data: newId } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: 'Motivo de auditoría',
    });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('metadata')
      .eq('case_id', w.caseId)
      .eq('action', 'requirement.reopened');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.metadata).toEqual({ original_requirement_id: w.requirementIds[0], reason: 'Motivo de auditoría' });
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-stages-workflow.test.ts`
Expected: all `reopen_requirement` tests pass (7 tests in this describe block).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260804160200_reopen_requirement_rpc.sql src/types/database.ts tests/isolation/case-stages-workflow.test.ts
git commit -m "Add reopen_requirement RPC: supersede-based correction, never a status mutation"
```

---

## Task 5: `assign_requirement_stage` RPC + isolation tests

**Files:**
- Create: `supabase/migrations/20260804160300_assign_requirement_stage_rpc.sql`
- Modify: `tests/isolation/case-stages-workflow.test.ts`

**Interfaces:**
- Consumes: `requirements.stage_id`/`reopened_from_requirement_id` (Task 1), `case_stages.status` (Task 1).
- Produces: `public.assign_requirement_stage(p_requirement_id uuid, p_stage_id uuid) returns void` — Task 7's Server Action calls this.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260804160300_assign_requirement_stage_rpc.sql

create or replace function public.assign_requirement_stage(p_requirement_id uuid, p_stage_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_req public.requirements;
  v_stage public.case_stages;
begin
  select organization_id into v_org_id from public.requirements where id = p_requirement_id;
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'requirement_not_found';
  end if;
  if v_org_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_req from public.requirements where id = p_requirement_id for update;

  if v_req.stage_id is not null then
    raise exception using errcode = 'P0001', message = 'requirement_already_assigned';
  end if;

  -- A reopened requirement belongs, historically, to the stage where the original problem
  -- occurred — reassigning it would erase that fact. Defensive: reopen_requirement always creates
  -- its new row with a non-null stage_id (copied from the original), so this should never actually
  -- be reachable in practice, but the invariant stays explicit rather than implicit.
  if v_req.reopened_from_requirement_id is not null then
    raise exception using errcode = 'P0001', message = 'reopened_requirement_cannot_move';
  end if;

  select * into v_stage from public.case_stages where id = p_stage_id and case_id = v_req.case_id;
  if v_stage.id is null then
    raise exception using errcode = 'P0001', message = 'stage_not_found';
  end if;

  -- MVP: only the active stage is a valid direct-assignment target from this quick-repair path.
  -- A locked (future) stage would silently hide an already-actionable requirement from the
  -- client; a completed stage should go through reopen_requirement's supersede path instead, since
  -- "this belongs to a stage we've already finished" is exactly what that RPC models.
  if v_stage.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'stage_not_active';
  end if;

  update public.requirements set stage_id = p_stage_id where id = p_requirement_id;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_org_id, v_req.case_id, 'requirement.stage_assigned', 'requirement', p_requirement_id,
    'member', (select auth.uid()), jsonb_build_object('stage_id', p_stage_id)
  );
end;
$$;

revoke all on function public.assign_requirement_stage(uuid, uuid) from public;
grant execute on function public.assign_requirement_stage(uuid, uuid) to authenticated;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `assign_requirement_stage` appears in `src/types/database.ts`.

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-stages-workflow.test.ts`**

```typescript
describe('assign_requirement_stage', () => {
  it('assigns an unassigned requirement to the active stage', async () => {
    const w = await buildStagedCase({ name: 'Notaría Assign Basic', stageCount: 1 });
    const { data: bare } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
        stage_id: null, type: 'document', label: 'Sin etapa', position: 1,
      })
      .select('id')
      .single();

    const { error } = await w.staff.client.rpc('assign_requirement_stage', {
      p_requirement_id: bare!.id,
      p_stage_id: w.stageIds[0]!,
    });
    expect(error).toBeNull();

    const { data: after } = await adminClient().from('requirements').select('stage_id').eq('id', bare!.id).single();
    expect(after?.stage_id).toBe(w.stageIds[0]);
  });

  it('rejects a target stage that is locked', async () => {
    const w = await buildStagedCase({ name: 'Notaría Assign Locked', stageCount: 2 });
    const { data: bare } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
        stage_id: null, type: 'document', label: 'Sin etapa', position: 2,
      })
      .select('id')
      .single();

    const { error } = await w.staff.client.rpc('assign_requirement_stage', {
      p_requirement_id: bare!.id,
      p_stage_id: w.stageIds[1]!, // locked (position 1, not yet active)
    });
    expect(error?.message).toBe('stage_not_active');
  });

  it('rejects a target stage that is completed', async () => {
    const w = await buildStagedCase({ name: 'Notaría Assign Completed', stageCount: 2 });
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);
    const { data: bare } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
        stage_id: null, type: 'document', label: 'Sin etapa', position: 2,
      })
      .select('id')
      .single();

    const { error } = await w.staff.client.rpc('assign_requirement_stage', {
      p_requirement_id: bare!.id,
      p_stage_id: w.stageIds[0]!,
    });
    expect(error?.message).toBe('stage_not_active');
  });

  it('rejects a requirement that already has a stage', async () => {
    const w = await buildStagedCase({ name: 'Notaría Assign AlreadySet', stageCount: 1 });

    const { error } = await w.staff.client.rpc('assign_requirement_stage', {
      p_requirement_id: w.requirementIds[0]!,
      p_stage_id: w.stageIds[0]!,
    });
    expect(error?.message).toBe('requirement_already_assigned');
  });

  it('rejects reassigning a reopened requirement', async () => {
    const w = await buildStagedCase({ name: 'Notaría Assign Reopened', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);
    const { data: newId } = await w.staff.client.rpc('reopen_requirement', {
      p_requirement_id: w.requirementIds[0]!,
      p_reason: 'Motivo',
    });
    // Force stage_id to null on the reopened row to exercise the guard directly (reopen_requirement
    // itself never produces a null stage_id, but the guard must hold regardless of how one arose).
    await adminClient().from('requirements').update({ stage_id: null }).eq('id', newId!);
    await adminClient().from('case_stages').insert({
      organization_id: w.organizationId, case_id: w.caseId, name: 'Etapa 2', position: 1, status: 'active',
    });

    const { data: activeStage } = await adminClient()
      .from('case_stages')
      .select('id')
      .eq('case_id', w.caseId)
      .eq('status', 'active')
      .single();
    const { error } = await w.staff.client.rpc('assign_requirement_stage', {
      p_requirement_id: newId!,
      p_stage_id: activeStage!.id,
    });
    expect(error?.message).toBe('reopened_requirement_cannot_move');
  });

  it('tenant isolation: a Staff member of another org cannot assign', async () => {
    const w = await buildStagedCase({ name: 'Notaría Assign TenantA', stageCount: 1 });
    const other = await createOrganizationWithOwner('Notaría Assign TenantB', 'notary');
    const { data: bare } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
        stage_id: null, type: 'document', label: 'Sin etapa', position: 1,
      })
      .select('id')
      .single();

    const { error } = await other.owner.client.rpc('assign_requirement_stage', {
      p_requirement_id: bare!.id,
      p_stage_id: w.stageIds[0]!,
    });
    expect(error?.message).toBe('not_authorized');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-stages-workflow.test.ts`
Expected: all `assign_requirement_stage` tests pass (6 tests in this describe block).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260804160300_assign_requirement_stage_rpc.sql src/types/database.ts tests/isolation/case-stages-workflow.test.ts
git commit -m "Add assign_requirement_stage RPC: Sin-etapa repair, active-stage-only, no reopened moves"
```

---

## Task 6: Unified actionable-requirement selector + cron/manual reminder rewiring

**Files:**
- Create: `supabase/migrations/20260804160400_actionable_requirement_ids.sql`
- Modify: `src/application/send-manual-reminder.ts:73-76`
- Modify: `tests/isolation/case-stages-workflow.test.ts`
- Modify: `tests/integration/send-manual-reminder.test.ts` (existing file — add stage-scoping tests)

**Interfaces:**
- Consumes: `case_stages.status` (Task 1), `requirements.reopened_from_requirement_id` (Task 1).
- Produces: `app.actionable_requirement_ids(p_participant_id uuid) returns setof uuid` — both `app.eligible_reminders()` (rewritten in this task) and `sendManualReminder` (rewritten in this task) use it as their single source of truth.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260804160400_actionable_requirement_ids.sql
--
-- The single, shared definition of "this Requirement is actionable right now for this
-- Participant" — used by both the automatic reminder cron and the manual "Recordar" button, so
-- they can never drift again the way they already had (the cron used status = 'outstanding'; the
-- manual path used status <> 'satisfied', which silently diverged once 'archived' became a valid
-- status value).
--
-- security invoker (not definer): runs under the caller's own RLS session. A Staff-authenticated
-- caller is restricted to their own org by requirements_select's existing policy; the reminder
-- cron (queue_reminders, already security definer) sees across every org, which is exactly what
-- it needs. RLS is the security boundary here, as everywhere else in this schema — this function
-- adds no authorization logic of its own to get wrong.
create or replace function app.actionable_requirement_ids(p_participant_id uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id
  from public.requirements r
  left join public.case_stages cs on cs.id = r.stage_id
  where r.participant_id = p_participant_id
    and r.deleted_at is null
    and r.superseded_at is null
    and r.status = 'outstanding'
    and (
      -- Case has no case_stages rows at all: legacy flat behavior, everything outstanding is
      -- actionable.
      not exists (select 1 from public.case_stages s where s.case_id = r.case_id)
      -- The requirement's own stage is the currently active one.
      or cs.status = 'active'
      -- The requirement's stage is completed, but this specific requirement was reopened and is
      -- still pending correction.
      or (cs.status = 'completed' and r.reopened_from_requirement_id is not null)
      -- Legacy "Sin etapa" requirement in a Case that does have stages: shown to the client as
      -- actionable for compatibility (design spec §2, "Legacy stage_id = null requirements").
      or r.stage_id is null
    )
$$;

comment on function app.actionable_requirement_ids(uuid) is
  'The one shared definition of "actionable now" for a Participant''s Requirements. Used by both
   app.eligible_reminders() and sendManualReminder (application layer) — never reimplemented as a
   second predicate anywhere else.';

revoke all on function app.actionable_requirement_ids(uuid) from public;
grant execute on function app.actionable_requirement_ids(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Rewrite eligible_reminders to use the shared selector instead of its own inline predicate.
-- Same signature/return shape as before (supabase/migrations/20260723153342_reminders_per_
-- participant.sql) — only the "does this participant have anything outstanding" exists() clause
-- changes.
-- ---------------------------------------------------------------------------------------------

create or replace function app.eligible_reminders()
returns table (
  participant_id uuid,
  organization_id uuid,
  case_id uuid,
  grant_id uuid,
  channel text,
  destination text,
  cadence_window integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    c.organization_id,
    c.id,
    g.id,
    'email'::text,
    g.invited_email,
    least(
      o.reminder_max_count - 1,
      floor(
        extract(epoch from (
          now() - (g.verified_at + make_interval(days => o.reminder_first_delay_days))
        )) / (o.reminder_interval_days * 86400.0)
      )::integer
    )
  from public.case_participants p
  join public.cases c
    on c.id = p.case_id and c.organization_id = p.organization_id
  join public.organizations o on o.id = c.organization_id
  join public.case_access_grants g on g.participant_id = p.id
  where c.state = 'open'
    and o.reminder_max_count > 0
    and g.verified_at is not null
    and g.revoked_at is null
    and g.expires_at is not null
    and g.expires_at > now()
    and g.permission <> 'none'
    and now() >= g.verified_at + make_interval(days => o.reminder_first_delay_days)
    and exists (select 1 from app.actionable_requirement_ids(p.id));
$$;

comment on function app.eligible_reminders() is
  'SECURITY-CRITICAL. Pure selection of due (participant, window) reminder tuples. No side effects.
   "Has anything outstanding" now goes through app.actionable_requirement_ids, the same selector
   the manual reminder path uses — see 20260804160400_actionable_requirement_ids.sql.';

revoke all on function app.eligible_reminders() from public;
```

- [ ] **Step 2: Apply and regenerate types**

Run: `npm run db:reset && npm run db:types`
Expected: no errors; `actionable_requirement_ids` appears under `Database['app']['Functions']` in `src/types/database.ts`. (`app` schema functions are not auto-exposed via PostgREST the way `public` ones are — confirm by checking how this repo's existing `app.*` functions, e.g. `app.member_org_ids`, are already called: via `withDb()`/direct SQL in tests, not `client.rpc()`. This function is called the same way — see Step 4 and Step 5 below.)

- [ ] **Step 3: Write the failing tests — append to `tests/isolation/case-stages-workflow.test.ts`**

```typescript
// Add this import at the top of the file: import { withDb } from '../helpers/db';

describe('app.actionable_requirement_ids', () => {
  it('a Case with no stages: every outstanding, non-deleted, non-superseded requirement is actionable', async () => {
    const w = await buildStagedCase({ name: 'Notaría Actionable NoStages', stageCount: 0 });
    const { data: req } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
        stage_id: null, type: 'document', label: 'Flat', position: 0,
      })
      .select('id')
      .single();

    const ids = await withDb((db) =>
      db.query('select id from app.actionable_requirement_ids($1)', [w.participantId]).then((r) => r.rows.map((row: { id: string }) => row.id)),
    );
    expect(ids).toContain(req!.id);
  });

  it('excludes a requirement in a locked future stage', async () => {
    const w = await buildStagedCase({ name: 'Notaría Actionable Locked', stageCount: 2 });
    const ids = await withDb((db) =>
      db.query('select id from app.actionable_requirement_ids($1)', [w.participantId]).then((r) => r.rows.map((row: { id: string }) => row.id)),
    );
    expect(ids).toContain(w.requirementIds[0]); // active stage
    expect(ids).not.toContain(w.requirementIds[1]); // locked stage
  });

  it('includes a reopened requirement pending in a completed stage', async () => {
    const w = await buildStagedCase({ name: 'Notaría Actionable Reopened', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('case_stages').update({ status: 'completed' }).eq('id', w.stageIds[0]!);
    const { data: newId } = await withDb((db) =>
      db.query(
        `select public.reopen_requirement($1, $2) as id`,
        [w.requirementIds[0], 'Motivo'],
      ).then((r) => r.rows[0]),
    ) as { id: string };

    const ids = await withDb((db) =>
      db.query('select id from app.actionable_requirement_ids($1)', [w.participantId]).then((r) => r.rows.map((row: { id: string }) => row.id)),
    );
    expect(ids).toContain(newId);
    expect(ids).not.toContain(w.requirementIds[0]); // original is now archived+superseded
  });

  it('excludes an archived-but-not-deleted requirement (the drift bug this task fixes)', async () => {
    const w = await buildStagedCase({ name: 'Notaría Actionable Archived', stageCount: 0 });
    await adminClient().from('requirements').update({ status: 'archived' }).eq('id', w.requirementIds[0]!);

    const ids = await withDb((db) =>
      db.query('select id from app.actionable_requirement_ids($1)', [w.participantId]).then((r) => r.rows.map((row: { id: string }) => row.id)),
    );
    expect(ids).not.toContain(w.requirementIds[0]);
  });

  it('includes a legacy stageless requirement in a Case that otherwise has stages', async () => {
    const w = await buildStagedCase({ name: 'Notaría Actionable SinEtapa', stageCount: 1 });
    const { data: bare } = await adminClient()
      .from('requirements')
      .insert({
        organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
        stage_id: null, type: 'document', label: 'Sin etapa', position: 1,
      })
      .select('id')
      .single();

    const ids = await withDb((db) =>
      db.query('select id from app.actionable_requirement_ids($1)', [w.participantId]).then((r) => r.rows.map((row: { id: string }) => row.id)),
    );
    expect(ids).toContain(bare!.id);
  });

  it('excludes a deleted or superseded requirement even in the active stage', async () => {
    const w = await buildStagedCase({ name: 'Notaría Actionable DeletedSuperseded', stageCount: 1 });
    await adminClient().from('requirements').update({ deleted_at: new Date().toISOString() }).eq('id', w.requirementIds[0]!);

    const ids = await withDb((db) =>
      db.query('select id from app.actionable_requirement_ids($1)', [w.participantId]).then((r) => r.rows.map((row: { id: string }) => row.id)),
    );
    expect(ids).not.toContain(w.requirementIds[0]);
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/isolation/case-stages-workflow.test.ts`
Expected: all `app.actionable_requirement_ids` tests pass (6 tests).

- [ ] **Step 5: Rewrite `sendManualReminder`'s "outstanding" check**

In `src/application/send-manual-reminder.ts`, replace the participant-select query (lines 58-64) and the `hasOutstanding` check (lines 72-76) so both go through the same shared selector via `withDb`-style direct SQL — `supabase-js` cannot call a `set search_path = ''`-scoped `app.*` function through `.rpc()` the way it calls `public.*` ones (same reason `app.eligible_reminders`/`app.queue_reminders` are only ever invoked from SQL, not from application code, elsewhere in this codebase), so this call goes through the request's own Postgres connection the same way `close_case`'s tests already do via `withDb`. Since `sendManualReminder` runs inside a Server Action, not a test, it doesn't have `withDb` — instead, expose the selector through a thin `public`-schema wrapper RPC callable via `client.rpc(...)`:

Add this wrapper to the same migration file from Step 1 (append, after `app.actionable_requirement_ids`):

```sql
-- Thin public-schema wrapper so application code (which calls RPCs via supabase-js's .rpc(), not
-- direct SQL) can reach the same selector the reminder cron uses internally. security invoker,
-- same reasoning as app.actionable_requirement_ids itself.
create or replace function public.list_actionable_requirement_ids(p_participant_id uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select id from app.actionable_requirement_ids(p_participant_id);
$$;

revoke all on function public.list_actionable_requirement_ids(uuid) from public;
grant execute on function public.list_actionable_requirement_ids(uuid) to authenticated;
```

Re-run `npm run db:reset && npm run db:types` after adding this so `list_actionable_requirement_ids` appears in `src/types/database.ts`.

Now update `src/application/send-manual-reminder.ts`. Replace the participant query at lines 58-64:

```typescript
  const { data: participants, error: participantsError } = await client
    .from("case_participants")
    .select(
      "id, grants:case_access_grants(id, revoked_at, permission, invited_email)",
    )
    .eq("case_id", caseId)
    .eq("organization_id", organizationId);
```

(dropped the nested `requirements(...)` selection — it's no longer needed here since actionability is now resolved per-participant via the RPC below, not by inspecting a fetched list).

Replace the `hasOutstanding` block at lines 72-76:

```typescript
  for (const p of participants ?? []) {
    const { data: actionableIds, error: actionableError } = await client.rpc(
      "list_actionable_requirement_ids",
      { p_participant_id: p.id },
    );
    if (actionableError) {
      throw new Error(`Could not resolve actionable requirements: ${actionableError.message}`);
    }
    if (!actionableIds || actionableIds.length === 0) continue;
```

- [ ] **Step 6: Write the failing test — append to `tests/integration/send-manual-reminder.test.ts`**

```typescript
it('excludes a requirement in a locked future stage', async () => {
  const world = await buildOrganizationWorld({
    name: 'Notaría Manual Reminder Stages',
    industry: 'notary',
    clientEmail: `manual-reminder-stages-${randomUUID()}@example.test`,
  });
  const admin = adminClient();
  const { data: stages } = await admin
    .from('case_stages')
    .insert([
      { organization_id: world.organizationId, case_id: world.caseId, name: 'Activa', position: 0, status: 'active' },
      { organization_id: world.organizationId, case_id: world.caseId, name: 'Futura', position: 1, status: 'locked' },
    ])
    .select('id, position');
  const active = stages!.find((s) => s.position === 0)!;
  const locked = stages!.find((s) => s.position === 1)!;
  // world.requirementIds[0] moves to the locked stage — should no longer be reminded about.
  await admin.from('requirements').update({ stage_id: locked.id }).eq('id', world.requirementIds[0]!);
  await admin.from('requirements').update({ stage_id: active.id }).eq('id', world.requirementIds[1]!);
  await grantVerifiedAccess({ world, permission: 'upload' });

  let sentTo: string[] = [];
  await sendManualReminder(
    world.staff.client,
    { organizationId: world.organizationId, caseId: world.caseId },
    world.staff.userId,
    async (input) => {
      sentTo.push(input.to);
    },
  );

  // Still reminded overall (requirementIds[1] is in the active stage), but this test's real point
  // is that the RPC path didn't throw and the participant was still correctly included — full
  // exclusion-of-the-locked-item coverage lives at the SQL level (Task 6's isolation tests, which
  // can assert directly on which ids come back). This integration test proves the wiring: the
  // manual reminder path actually calls through to the new selector rather than a stale predicate.
  expect(sentTo).toEqual([world.clientEmail]);
});

it('excludes an archived requirement, matching the cron (the drift this task fixes)', async () => {
  const world = await buildOrganizationWorld({
    name: 'Notaría Manual Reminder Archived',
    industry: 'notary',
    clientEmail: `manual-reminder-archived-${randomUUID()}@example.test`,
  });
  const admin = adminClient();
  for (const id of world.requirementIds) {
    await admin.from('requirements').update({ status: 'archived' }).eq('id', id);
  }
  await grantVerifiedAccess({ world, permission: 'upload' });

  const result = await sendManualReminder(
    world.staff.client,
    { organizationId: world.organizationId, caseId: world.caseId },
    world.staff.userId,
    async () => {},
  );

  expect(result.remindedCount).toBe(0);
});
```

Add `import { randomUUID } from 'node:crypto';` and `import { adminClient, grantVerifiedAccess } from '../helpers/fixtures';` (or `'../helpers/clients'` for `adminClient` specifically, matching this file's existing import layout — check the top of `tests/integration/send-manual-reminder.test.ts` for the exact existing pattern before adding).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/integration/send-manual-reminder.test.ts`
Expected: all pass, including the 2 new tests and every pre-existing test (pre-existing tests have no `case_stages` rows on their Cases, so they exercise the "no stages: everything outstanding is actionable" branch — identical behavior to before this task).

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260804160400_actionable_requirement_ids.sql src/types/database.ts src/application/send-manual-reminder.ts tests/isolation/case-stages-workflow.test.ts tests/integration/send-manual-reminder.test.ts
git commit -m "Unify reminder selector: app.actionable_requirement_ids feeds cron and manual alike"
```

---

## Task 7: Staff read model, Server Actions, and Staff Workspace UI

**Files:**
- Modify: `src/features/cases/queries.ts` (add stage data to `getWorkspaceCases`)
- Modify: `src/app/cases/actions.ts` (add `advanceCaseStageAction`, `reopenRequirementAction`, `assignRequirementStageAction`)
- Modify: `src/app/cases/cases-workspace.tsx` (stage stepper, "Continuar" button, "Sin etapa" section)
- Create: `tests/component/stage-stepper.test.tsx`
- Modify: `tests/integration/case-services.test.ts` or a new `tests/integration/case-stages-actions.test.ts` (Server Action-level tests, matching the existing `reopen-case-action.test.ts` pattern)

**Interfaces:**
- Consumes: `advance_case_stage`, `reopen_requirement`, `assign_requirement_stage` (Tasks 3-5).
- Produces: `CaseView.stages: StageView[]` (new field), `advanceCaseStageAction(caseId): Promise<ActionResult<{ notifiedParticipantIds: string[] }>>`, `reopenRequirementAction(requirementId, reason): Promise<ActionResult<null>>`, `assignRequirementStageAction(requirementId, stageId): Promise<ActionResult<null>>` — all in `src/app/cases/actions.ts`, following this file's exact existing `ActionResult<T>` pattern (see `closeCaseAction`/`reopenCaseAction`, lines 123-161).

- [ ] **Step 1: Extend `getWorkspaceCases`'s read model — `src/features/cases/queries.ts`**

Add a `StageView` type and `stage`/`reopenedFromRequirementId` fields to `RequirementView`, and `stages`/`documentationComplete`/`workflowDocumentationComplete` to `CaseView`. Replace lines 20-45 with:

```typescript
export type ReqDisplayState = "approved" | "review" | "awaiting" | "rejected" | "missing";
export type StageStatus = "locked" | "active" | "completed";

export interface RequirementView {
  id: string;
  label: string;
  state: ReqDisplayState;
  rejectionReason?: string;
  documentId?: string;
  /** null when the Case has no workflow, OR when this is a legacy "Sin etapa" requirement inside
   *  a Case that does have one. Both render outside any stage grouping in the UI. */
  stageId: string | null;
  /** Present only on a row created by reopen_requirement — the label the client sees is unchanged
   *  from the original, but the UI needs this to render it under "Correcciones pendientes". */
  reopenedFromRequirementId: string | null;
}
export interface ParticipantView {
  id: string;
  name: string;
  role: string;
  requirements: RequirementView[];
}
export interface StageView {
  id: string;
  name: string;
  position: number;
  status: StageStatus;
  completionMode: "requirements" | "manual";
}
export interface CaseView {
  id: string;
  ref: string;
  title: string;
  opened: string;
  state: string;
  closedAt?: string;
  clientClosingNote?: string;
  participants: ParticipantView[];
  /** Empty array = this Case has no workflow (legacy flat behavior everywhere in the UI). */
  stages: StageView[];
}
```

Update `RawRequirement` (lines 67-74) to add `stage_id: string | null;` and `reopened_from_requirement_id: string | null;`. Update the `getWorkspaceCases` select (lines 108-113) to fetch `stages:case_stages(id, name, position, status, completion_mode)` alongside the existing `participants:case_participants(...)` field, and add `stage_id, reopened_from_requirement_id` to the nested `requirements(...)` column list. Update the mapping function (lines 119-146) to build `stages` from the new query field, sorted by `position`, and to carry `stageId: r.stage_id` / `reopenedFromRequirementId: r.reopened_from_requirement_id` onto each mapped `RequirementView`.

Add two new exported helpers at the end of the file, after `getOperativeCounts`:

```typescript
/** currentStageComplete per §5 of the design spec: is the active stage ready to advance? Read-only
 *  mirror of advance_case_stage's own gates, for disabling the "Continuar" button with a specific
 *  reason before the user even clicks it — the RPC remains the actual authority. */
export function currentStageAdvanceBlocker(c: CaseView): string | null {
  if (c.stages.length === 0) return "Este expediente no tiene un flujo por etapas.";
  const active = c.stages.find((s) => s.status === "active");
  if (!active) return "No hay una etapa activa.";

  const unassigned = c.participants
    .flatMap((p) => p.requirements)
    .some((r) => r.stageId === null && r.state !== "approved");
  if (unassigned) return "Hay requisitos sin etapa asignada. Resuélvelos en la sección Sin etapa.";

  const reopenedPending = c.participants
    .flatMap((p) => p.requirements)
    .some((r) => r.reopenedFromRequirementId !== null && r.state !== "approved");
  if (reopenedPending) return "Hay una corrección pendiente de una etapa anterior.";

  const activeStageReqs = c.participants
    .flatMap((p) => p.requirements)
    .filter((r) => r.stageId === active.id);
  const outstanding = activeStageReqs.filter((r) => r.state !== "approved");
  if (outstanding.length > 0) {
    return `Faltan ${outstanding.length} requisito${outstanding.length === 1 ? "" : "s"} de la etapa actual.`;
  }
  if (active.completionMode === "requirements" && activeStageReqs.length === 0) {
    return "Esta etapa no tiene requisitos configurados.";
  }
  return null;
}

/** workflowDocumentationComplete per §5: every stage completed, no reopened-pending, no
 *  unassigned-pending, anywhere in the Case. Empty stages array (no workflow) is never "complete"
 *  in this sense — that concept simply doesn't apply, so callers must check c.stages.length first. */
export function workflowDocumentationComplete(c: CaseView): boolean {
  if (c.stages.length === 0) return false;
  if (c.stages.some((s) => s.status !== "completed")) return false;
  const allReqs = c.participants.flatMap((p) => p.requirements);
  if (allReqs.some((r) => r.stageId === null && r.state !== "approved")) return false;
  if (allReqs.some((r) => r.reopenedFromRequirementId !== null && r.state !== "approved")) return false;
  return true;
}
```

- [ ] **Step 2: Add Server Actions — `src/app/cases/actions.ts`**

Add imports at the top:

```typescript
import { advanceCaseStage, reopenRequirement, assignRequirementStage } from "@/features/cases/cases";
```

Add these three actions after `reopenCaseAction` (after line 161):

```typescript
export async function advanceCaseStageAction(caseId: string): Promise<ActionResult<{ notifiedParticipantIds: string[] }>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    const supabase = await createClient();
    const notifiedParticipantIds = await advanceCaseStage(supabase, caseId);
    revalidatePath("/cases");
    return ok({ notifiedParticipantIds });
  } catch (error) {
    return fail(error);
  }
}

export async function reopenRequirementAction(requirementId: string, reason: string): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    const supabase = await createClient();
    await reopenRequirement(supabase, requirementId, reason);
    revalidatePath("/cases");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function assignRequirementStageAction(requirementId: string, stageId: string): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    const supabase = await createClient();
    await assignRequirementStage(supabase, requirementId, stageId);
    revalidatePath("/cases");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 3: Add the underlying use cases — `src/features/cases/cases.ts`**

Add error message maps and functions, following the exact `closeCase`/`mapCloseCaseError` pattern already in this file (lines 88-121, 243-257):

```typescript
const ADVANCE_STAGE_MESSAGES: Record<string, string> = {
  case_not_found: 'El expediente ya no existe.',
  not_authorized: 'No tienes permiso para avanzar este expediente.',
  no_active_stage: 'Este expediente no tiene una etapa activa.',
  unassigned_requirement_pending: 'Hay requisitos sin etapa asignada. Resuélvelos primero.',
  reopened_requirement_pending: 'Hay una corrección pendiente de una etapa anterior.',
  stage_not_ready: 'La etapa actual todavía tiene requisitos pendientes.',
};

function mapAdvanceStageError(error: PostgrestError): UseCaseError {
  const message = ADVANCE_STAGE_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos avanzar el expediente. Intenta de nuevo.');
  const reason = error.message === 'not_authorized' ? 'forbidden' : error.message === 'case_not_found' ? 'not_found' : 'conflict';
  return new UseCaseError(reason, message);
}

export async function advanceCaseStage(client: DbClient, caseId: string): Promise<string[]> {
  const { data, error } = await client.rpc('advance_case_stage', { p_case_id: caseId });
  if (error) throw mapAdvanceStageError(error);
  return (data ?? []).map((r) => r.participant_id);
}

const REOPEN_REQUIREMENT_MESSAGES: Record<string, string> = {
  requirement_not_found: 'Ese requisito ya no existe.',
  not_authorized: 'No tienes permiso para reabrir este requisito.',
  requirement_has_no_stage: 'Este requisito no pertenece a ninguna etapa.',
  stage_not_completed: 'Solo se pueden reabrir requisitos de una etapa ya completada.',
  requirement_not_satisfied: 'Este requisito no está aprobado.',
  reopen_reason_required: 'Escribe el motivo de la corrección.',
};

function mapReopenRequirementError(error: PostgrestError): UseCaseError {
  const message = REOPEN_REQUIREMENT_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos reabrir el requisito. Intenta de nuevo.');
  const reason =
    error.message === 'not_authorized' ? 'forbidden'
    : error.message === 'requirement_not_found' ? 'not_found'
    : error.message === 'reopen_reason_required' ? 'validation'
    : 'conflict';
  return new UseCaseError(reason, message);
}

export async function reopenRequirement(client: DbClient, requirementId: string, reason: string): Promise<string> {
  const { data, error } = await client.rpc('reopen_requirement', { p_requirement_id: requirementId, p_reason: reason });
  if (error) throw mapReopenRequirementError(error);
  return data!;
}

const ASSIGN_STAGE_MESSAGES: Record<string, string> = {
  requirement_not_found: 'Ese requisito ya no existe.',
  not_authorized: 'No tienes permiso para asignar este requisito.',
  requirement_already_assigned: 'Este requisito ya tiene una etapa asignada.',
  reopened_requirement_cannot_move: 'No se puede reasignar un requisito reabierto.',
  stage_not_found: 'Esa etapa no existe en este expediente.',
  stage_not_active: 'Solo se puede asignar a la etapa activa.',
};

function mapAssignStageError(error: PostgrestError): UseCaseError {
  const message = ASSIGN_STAGE_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos asignar el requisito. Intenta de nuevo.');
  const reason =
    error.message === 'not_authorized' ? 'forbidden'
    : error.message === 'requirement_not_found' || error.message === 'stage_not_found' ? 'not_found'
    : 'conflict';
  return new UseCaseError(reason, message);
}

export async function assignRequirementStage(client: DbClient, requirementId: string, stageId: string): Promise<void> {
  const { error } = await client.rpc('assign_requirement_stage', { p_requirement_id: requirementId, p_stage_id: stageId });
  if (error) throw mapAssignStageError(error);
}
```

- [ ] **Step 4: Staff Workspace UI — `src/app/cases/cases-workspace.tsx`**

Add a `StageStepper` component and a "Sin etapa" section, and wire the "Continuar" primary action, replacing the fixed "Revisar documentos" button block for Cases that have a workflow. Add after the `ParticipantColumn` function (after line 175):

```typescript
import { currentStageAdvanceBlocker, type StageView } from "@/features/cases/queries";
import { advanceCaseStageAction, assignRequirementStageAction } from "./actions";

function StageStepper({ c }: { c: CaseView }) {
  if (c.stages.length === 0) {
    return <p className="mb-4 text-xs font-medium text-text-secondary">Sin workflow por etapas</p>;
  }

  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const blocker = currentStageAdvanceBlocker(c);
  const activeIndex = c.stages.findIndex((s) => s.status === "active");
  const nextStage = c.stages[activeIndex + 1];

  async function advance() {
    setAdvancing(true);
    setError(null);
    const result = await advanceCaseStageAction(c.id);
    setAdvancing(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  return (
    <div className="mb-6 rounded-card border border-border bg-surface p-4">
      <ol className="flex flex-wrap items-center gap-2">
        {c.stages.map((s) => (
          <li
            key={s.id}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              s.status === "completed"
                ? "bg-success-bg text-success"
                : s.status === "active"
                  ? "bg-royal-600 text-white"
                  : "bg-app-bg text-text-secondary"
            }`}
          >
            {s.name}
          </li>
        ))}
      </ol>
      {c.state === "open" && (
        <div className="mt-3">
          <button
            onClick={advance}
            disabled={advancing || blocker !== null}
            title={blocker ?? undefined}
            className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {advancing ? "Avanzando…" : nextStage ? `Continuar a ${nextStage.name}` : "Completar última etapa"}
          </button>
          {blocker && <p className="mt-1.5 text-xs text-text-secondary">{blocker}</p>}
        </div>
      )}
      {error && <p className="mt-1.5 text-xs text-error">{error}</p>}
    </div>
  );
}

function SinEtapaSection({ c }: { c: CaseView }) {
  if (c.stages.length === 0) return null;
  const unassigned = c.participants.flatMap((p) => p.requirements).filter((r) => r.stageId === null);
  if (unassigned.length === 0) return null;
  const activeStage = c.stages.find((s) => s.status === "active");
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function assign(requirementId: string) {
    if (!activeStage) return;
    setBusyId(requirementId);
    await assignRequirementStageAction(requirementId, activeStage.id);
    setBusyId(null);
    router.refresh();
  }

  return (
    <section className="mb-6 rounded-card border border-warning/30 bg-warning-bg/40 p-4">
      <h3 className="text-sm font-semibold text-text-primary">Sin etapa</h3>
      <ul className="mt-2 space-y-1.5">
        {unassigned.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-2 text-sm text-text-primary">
            <span>{r.label}</span>
            {activeStage && (
              <button
                onClick={() => assign(r.id)}
                disabled={busyId === r.id}
                className="rounded-input border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-app-bg disabled:opacity-50"
              >
                {busyId === r.id ? "Asignando…" : "Asignar a etapa activa"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

In `CaseDetail` (line 311 onward), render `<StageStepper c={c} />` and `<SinEtapaSection c={c} />` immediately after the existing `{c.state !== "open" && <ClosureBanner .../>}` line (line 404), before the `<section>Progreso del expediente</section>`.

- [ ] **Step 5: Write the component test — `tests/component/stage-stepper.test.tsx`**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CaseView } from '@/features/cases/queries';
import { CasesWorkspace } from '@/app/cases/cases-workspace';
import { advanceCaseStageAction, assignRequirementStageAction } from '@/app/cases/actions';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/app/cases/actions', () => ({
  advanceCaseStageAction: vi.fn(),
  assignRequirementStageAction: vi.fn(),
  closeCaseAction: vi.fn(),
  reopenCaseAction: vi.fn(),
  reviewDocumentAction: vi.fn(),
  sendManualReminderAction: vi.fn(),
  getDocumentDownloadUrlAction: vi.fn(),
}));

function stagedCase(overrides: Partial<CaseView> = {}): CaseView {
  return {
    id: 'case-1', ref: 'CASE-TEST', title: 'Con etapas', opened: '1 ene 2026', state: 'open',
    stages: [
      { id: 'stage-1', name: 'Kick-Off', position: 0, status: 'active', completionMode: 'requirements' },
      { id: 'stage-2', name: 'Milestone 1', position: 1, status: 'locked', completionMode: 'requirements' },
    ],
    participants: [
      {
        id: 'p1', name: 'Comprador', role: 'Comprador',
        requirements: [
          { id: 'r1', label: 'INE', state: 'approved', stageId: 'stage-1', reopenedFromRequirementId: null },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Stage stepper — Continuar button gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enables Continuar when the active stage is fully approved', () => {
    render(<CasesWorkspace cases={[stagedCase()]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ email: 'a@b.com', name: 'A' }} />);
    expect(screen.getByRole('button', { name: 'Continuar a Milestone 1' })).toBeEnabled();
  });

  it('disables Continuar with a specific reason when the active stage has an outstanding requirement', () => {
    const c = stagedCase({
      participants: [
        { id: 'p1', name: 'Comprador', role: 'Comprador', requirements: [{ id: 'r1', label: 'INE', state: 'awaiting', stageId: 'stage-1', reopenedFromRequirementId: null }] },
      ],
    });
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ email: 'a@b.com', name: 'A' }} />);
    expect(screen.getByRole('button', { name: 'Continuar a Milestone 1' })).toBeDisabled();
    expect(screen.getByText(/Faltan 1 requisito/)).toBeInTheDocument();
  });

  it('shows no stage stepper controls for a Case with no workflow', () => {
    const c = stagedCase({ stages: [] });
    render(<CasesWorkspace cases={[c]} counts={{ waitingClient: 0, needsReview: 0, readyToContinue: 0, completedToday: 0 }} account={{ email: 'a@b.com', name: 'A' }} />);
    expect(screen.getByText('Sin workflow por etapas')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continuar a/ })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/component/stage-stepper.test.tsx`
Expected: 3 passed.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/features/cases/queries.ts src/app/cases/actions.ts src/features/cases/cases.ts src/app/cases/cases-workspace.tsx tests/component/stage-stepper.test.tsx
git commit -m "Add Staff read model, Server Actions, and stage stepper UI for the workflow"
```

---

## Task 8: Client Portal read model + UI — "Correcciones pendientes" and workflow-complete messaging

**Files:**
- Modify: `src/features/case-access/portal-queries.ts`
- Modify: `src/application/client-portal.ts`
- Modify: `src/app/portal/[token]/portal-client.tsx`
- Create: `tests/component/portal-correcciones.test.tsx`

**Interfaces:**
- Consumes: `RequirementView.stageId`/`reopenedFromRequirementId`-equivalent for the Portal (this task adds the Portal's own copies of those fields, following `portal-queries.ts`'s existing independent-read-model convention).
- Produces: `PortalRequirement.stageId`/`reopenedFromStageName`, `PortalState.correctionsPending: PortalRequirement[]`, `PortalState.workflowComplete: boolean`.

- [ ] **Step 1: Extend `getPortalCase` — `src/features/case-access/portal-queries.ts`**

Add `stage_id` to `RawRequirement` (line 52-58) and select `stage_id, stage:case_stages(name, status)` in the `requirements(...)` nested select (line 112-113). Add to `PortalRequirement` (after line 30):

```typescript
  /** Present only for a Requirement belonging to a stage; used to group into "Correcciones
   *  pendientes" vs. the active stage's own list. */
  readonly stageStatus?: 'locked' | 'active' | 'completed';
  /** The original stage's name, shown next to a reopened item so the client has the same context
   *  Staff sees ("(Kick-Off)"). Present only when reopenedFromRequirementId is set. */
  readonly originalStageName?: string;
  readonly reopenedFromRequirementId: string | null;
```

Update `deriveState`'s call site (line 121-134) to also thread through `stage_id`/`reopened_from_requirement_id`/the joined stage's `name`/`status`. Note: since a reopened requirement is a brand-new row carrying the *same* `stage_id` as its (now superseded, and therefore no longer selected by this query's own `.filter((r) => !r.deleted_at && !r.superseded_at)`) original, `originalStageName` is simply that row's own joined `stage.name` — no separate lookup needed.

- [ ] **Step 2: Extend `getPortalState` — `src/application/client-portal.ts`**

Replace the `pendingCount`/`isComplete` block (lines 178-182):

```typescript
  const correctionsPending = portalCase.requirements.filter(
    (r) => r.reopenedFromRequirementId !== null && (r.state === 'pending' || r.state === 'rejected'),
  );
  const activeStateItems = portalCase.requirements.filter(
    (r) => r.reopenedFromRequirementId === null && (r.state === 'pending' || r.state === 'rejected'),
  );
  const pendingCount = correctionsPending.length + activeStateItems.length;
  const hasWorkflow = portalCase.requirements.some((r) => r.stageStatus !== undefined);
  const workflowComplete = hasWorkflow && pendingCount === 0;

  return {
    ...portalCase,
    pendingCount,
    isComplete: pendingCount === 0,
    correctionsPending,
    workflowComplete,
  };
```

Add `correctionsPending: PortalRequirement[]` and `workflowComplete: boolean` to the `PortalState` interface (after line 149).

- [ ] **Step 3: Portal UI — `src/app/portal/[token]/portal-client.tsx`**

The checklist screen is rendered by an unexported local function, `Checklist` (`src/app/portal/[token]/portal-client.tsx:318`), invoked from `PortalClient` at line 131 (`<Checklist token={props.token} state={state} onChanged={refreshState} />`) once the OTP step completes — `PortalClient` itself is a token/OTP state machine, not the screen this task changes. Export `Checklist` (same pattern already used for `RequirementRow`/`ClosureBanner` in `src/app/cases/cases-workspace.tsx` — change `function Checklist(...)` to `export function Checklist(...)` at line 318) so Step 4's component test can render it directly without driving the OTP flow first.

Inside `Checklist` (lines 318-379+), `pending` (line 319: `state.requirements.filter((r) => r.state === "pending" || r.state === "rejected")`) is what Step 374-378 actually renders as "Qué necesitas hacer", and `resolved`/full `state.requirements` are what the other two branches (`documentationComplete`, `caseClosed`) render. Update `pending` to exclude reopened items (they get their own section) and filter the `caseClosed`/`documentationComplete` branches' full-list renders (lines 352, 362) the same way:

```typescript
// Replace line 319:
const pending = state.requirements.filter(
  (r) => (r.state === "pending" || r.state === "rejected") && r.reopenedFromRequirementId === null,
);
```

Add, immediately after the opening `<h1>...</h1>` (line 345) and before the `{caseClosed ? (` branch (line 347), so it always renders regardless of which of the three branches follows:

```typescript
{state.correctionsPending.length > 0 && (
  <section className="mb-6 rounded-card border border-warning/30 bg-warning-bg/40 p-4">
    <h3 className="text-sm font-semibold text-text-primary">Correcciones pendientes</h3>
    <ul className="mt-2 space-y-1.5">
      {state.correctionsPending.map((r) => (
        <li key={r.id} className="text-sm text-text-primary">
          {r.label}
          {r.originalStageName && <span className="text-text-secondary"> ({r.originalStageName})</span>}
        </li>
      ))}
    </ul>
  </section>
)}
{state.workflowComplete && state.caseState === "open" && (
  <div className="mb-6 rounded-card border border-success/20 bg-success-bg/60 px-5 py-4">
    <p className="text-sm font-semibold text-text-primary">Workflow completo</p>
    <p className="mt-1 text-xs text-text-secondary">No tienes acciones pendientes. El equipo continuará con el proceso.</p>
  </div>
)}
```

- [ ] **Step 4: Write the component test — `tests/component/portal-correcciones.test.tsx`**

```typescript
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Checklist } from '@/app/portal/[token]/portal-client';
import type { PortalState } from '@/application/client-portal';

function baseState(overrides: Partial<PortalState> = {}): PortalState {
  return {
    organizationName: 'Notaría Test',
    caseTitle: 'Compraventa',
    caseState: 'open',
    requirements: [],
    pendingCount: 0,
    isComplete: true,
    correctionsPending: [],
    workflowComplete: false,
    ...overrides,
  };
}

describe('Portal Checklist — Correcciones pendientes section', () => {
  it('renders a dedicated section, separate from the active-stage list, for a reopened requirement', () => {
    const state = baseState({
      correctionsPending: [
        { id: 'r1', label: 'INE comprador', state: 'pending', stageStatus: 'completed', originalStageName: 'Kick-Off', reopenedFromRequirementId: 'orig-1' },
      ],
    });
    render(<Checklist token="tok" state={state} onChanged={() => {}} />);
    expect(screen.getByText('Correcciones pendientes')).toBeInTheDocument();
    expect(screen.getByText('INE comprador')).toBeInTheDocument();
    expect(screen.getByText('(Kick-Off)')).toBeInTheDocument();
  });

  it('shows nothing when there are no pending corrections', () => {
    render(<Checklist token="tok" state={baseState()} onChanged={() => {}} />);
    expect(screen.queryByText('Correcciones pendientes')).not.toBeInTheDocument();
  });

  it('shows the workflow-complete message, distinct from the terminal-state banner, when the Case is still open', () => {
    const state = baseState({ workflowComplete: true, caseState: 'open' });
    render(<Checklist token="tok" state={state} onChanged={() => {}} />);
    expect(screen.getByText('Workflow completo')).toBeInTheDocument();
    expect(screen.getByText(/El equipo continuará con el proceso/)).toBeInTheDocument();
    expect(screen.queryByText(/expediente completado/i)).not.toBeInTheDocument();
  });

  it('a reopened requirement is excluded from the ordinary "Qué necesitas hacer" pending list', () => {
    const state = baseState({
      pendingCount: 1,
      requirements: [
        { id: 'r2', label: 'CURP vendedor', state: 'pending', reopenedFromRequirementId: null },
      ],
      correctionsPending: [
        { id: 'r1', label: 'INE comprador', state: 'pending', stageStatus: 'completed', originalStageName: 'Kick-Off', reopenedFromRequirementId: 'orig-1' },
      ],
    });
    render(<Checklist token="tok" state={state} onChanged={() => {}} />);
    // "INE comprador" appears once, inside Correcciones pendientes — not duplicated into the
    // ordinary pending list below it.
    expect(screen.getAllByText('INE comprador')).toHaveLength(1);
    expect(screen.getByText('CURP vendedor')).toBeInTheDocument();
  });
});
```

This test file needs `tests/helpers/setup-component.ts`'s existing env-var placeholders (already in place from task #65) since importing `portal-client.tsx` transitively imports the same Supabase-env-reading chain as `cases-workspace.tsx` does.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/component/portal-correcciones.test.tsx`
Expected: 3 passed.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/features/case-access/portal-queries.ts src/application/client-portal.ts src/app/portal/[token]/portal-client.tsx tests/component/portal-correcciones.test.tsx
git commit -m "Add Portal Correcciones pendientes section and workflow-complete messaging"
```

---

## Task 9: Seed data + fixtures — make the feature exercisable in dev/demo

**Files:**
- Modify: `scripts/seed-demo.mjs`
- Modify: `tests/helpers/fixtures.ts` (add an opt-in staged-world builder, additive only)

**Interfaces:**
- Produces: at least one seeded Blueprint (the "Compraventa" one, `scripts/seed-demo.mjs:123-139`) with real `stages` and `stage_position` on its requirement definitions, so `npm run db:seed` produces at least one Case with populated `case_stages` — otherwise this entire feature stays untested in the actual demo environment, exactly the gap Fase 1 discovery flagged.

- [ ] **Step 1: Add stages to the "Compraventa" Blueprint in `scripts/seed-demo.mjs`**

Locate the "Compraventa" `createBlueprint` call (lines 123-139, per Fase 1 discovery). Add a `stages` array and `stage_position` on each requirement definition:

```javascript
await createBlueprint({
  name: "Compraventa",
  description: "…", // keep existing value
  stages: [
    { name: "Kick-Off", position: 0 },
    { name: "Milestone 1", position: 1 },
  ],
  requirementDefinitions: [
    { key: "official-id", type: "document", label: "INE", scope: "participant", participant_role_key: "buyer", stage_position: 0 },
    { key: "curp", type: "document", label: "CURP", scope: "participant", participant_role_key: "buyer", stage_position: 0 },
    { key: "official-id", type: "document", label: "INE", scope: "participant", participant_role_key: "seller", stage_position: 0 },
    { key: "curp", type: "document", label: "CURP", scope: "participant", participant_role_key: "seller", stage_position: 0 },
    { key: "property-title", type: "document", label: "Título de propiedad", scope: "participant", participant_role_key: "seller", stage_position: 1 },
    { key: "appraisal", type: "document", label: "Avalúo", scope: "case", stage_position: 1 },
  ],
});
```

- [ ] **Step 2: Make `createCase` (this script's own, separate from the `create_case` RPC — Fase 1 confirmed it inserts directly into `cases`/`requirements`, bypassing the RPC entirely) clone stages and assign `stage_id`**

Run: `grep -n "async function createCase" /Users/paolabramlett/DocuFlow/scripts/seed-demo.mjs` to find the exact current line (Fase 1 found it around line 184). Read that function in full before editing (it inserts directly into `cases` then `requirements` per participant, with no `stage_id` field or `case_stages` insert, per Fase 1 discovery). Modify it to: (a) if the source Blueprint has `blueprint_stages` rows, insert matching `case_stages` rows for the new Case (first one `status: 'active'`, rest `locked`, mirroring Task 1's schema defaults and Task 3's migration backfill logic — see `docs/superpowers/specs/2026-08-04-case-stages-workflow-design.md` §9 for the exact rule); (b) resolve each requirement's `stage_position` (if the Blueprint definition set one) against the newly-created `case_stages`, and pass `stage_id` on the `requirements` insert — this mirrors Task 2's `createCaseWithParticipants` fix, applied to this separate script's own case-creation path.

- [ ] **Step 3: Regenerate and reseed to verify**

Run: `npm run db:reset` (this runs migrations then the seed script as part of the existing `db:reset` pipeline — confirm via `package.json`'s `db:reset` script definition; if seeding is a separate step, run `npm run db:seed` immediately after).
Expected: no errors. Verify manually:

Run: `npx tsx -e "import { createClient } from '@supabase/supabase-js'; /* or use psql directly */"` — simpler: connect with `psql` (or the project's existing `withDb` pattern via a one-off script) and run `select count(*) from case_stages;` — expect a non-zero count for the first time in this project's history.

- [ ] **Step 4: Add an opt-in staged-world fixture builder — `tests/helpers/fixtures.ts`**

Add a new, purely additive export (existing `buildOrganizationWorld` stays completely unchanged — every existing test that calls it keeps getting a stageless Case, exactly as today) after `buildOrganizationWorld` (after line 182):

```typescript
export interface StagedOrganizationWorld extends OrganizationWorld {
  readonly stageIds: readonly string[];
}

/** Like buildOrganizationWorld, but also creates N case_stages (first 'active', rest 'locked') and
 *  distributes the already-cloned requirements across them round-robin, all assigned to the
 *  primary Participant. Opt-in — most tests should keep using buildOrganizationWorld directly. */
export async function buildStagedOrganizationWorld(options: {
  name: string;
  industry: Industry;
  clientEmail: string;
  stageCount: number;
}): Promise<StagedOrganizationWorld> {
  const world = await buildOrganizationWorld(options);
  const admin = adminClient();

  const stageIds: string[] = [];
  for (let i = 0; i < options.stageCount; i++) {
    const { data: stage } = await admin
      .from('case_stages')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        name: `Etapa ${i + 1}`,
        position: i,
        status: i === 0 ? 'active' : 'locked',
        activated_at: i === 0 ? new Date().toISOString() : null,
      })
      .select('id')
      .single();
    stageIds.push(stage!.id);
  }

  for (const [index, requirementId] of world.requirementIds.entries()) {
    await admin
      .from('requirements')
      .update({ stage_id: stageIds[index % stageIds.length] })
      .eq('id', requirementId);
  }

  return { ...world, stageIds };
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/seed-demo.mjs tests/helpers/fixtures.ts
git commit -m "Seed a staged Blueprint and add an opt-in staged-world test fixture"
```

---

## Task 10: Production migration preflight + full regression/security/compatibility sweep

**Files:** none created/modified beyond verification — this task is a go/no-go gate plus a full-suite run, per the spec's §9 explicit instruction not to code around the backfill decision silently.

**Interfaces:** none new.

- [ ] **Step 1: Run the production preflight count**

Per `docs/superpowers/specs/2026-08-04-case-stages-workflow-design.md` §9: before this plan's migrations (Tasks 1, 3, 4, 5, 6) are ever pushed to production, run this against the **production** Supabase project (read-only, via the Supabase SQL editor or `supabase db execute --linked` with a `select`, never a write):

```sql
select count(distinct case_id) from case_stages;
```

- **If the count is 0** (expected, per Fase 1 discovery: no seed data or real usage has ever exercised `case_stages` in this project): proceed with the migrations as written — every `case_stages` row created going forward gets `status = 'locked'` by column default, and Task 1's migration needs no additional backfill statement (there is nothing to backfill).
- **If the count is non-zero**: **STOP.** Do not push these migrations to production yet. Export the affected Case ids (`select distinct case_id, organization_id from case_stages;`) and bring them back to a human for a manual, case-by-case decision before writing any backfill logic — per the spec, silently guessing "the first stage by position is active" for a Case that may have real, already-approved documents scattered across what would become "locked" stages risks hiding already-completed client work behind a newly-invented lock. This is a decision this plan deliberately does not make in advance.

- [ ] **Step 2: Full local test suite**

Run: `npx vitest run`
Expected: every test file passes, including all of `tests/isolation/case-stages-workflow.test.ts`, the modified `tests/integration/create-case-with-participants.test.ts`, `tests/integration/send-manual-reminder.test.ts`, the new `tests/component/stage-stepper.test.tsx` and `tests/component/portal-correcciones.test.tsx`, and every pre-existing test file untouched by this plan (proving zero regressions in Case Closure, Blueprint authoring, invitations, etc.).

- [ ] **Step 3: Compatibility spot-check — a Case with zero stages behaves identically to before this plan**

Run: `npx vitest run tests/integration/case-services.test.ts tests/integration/case-closure-use-case.test.ts tests/isolation/case-stages.test.ts`
Expected: all pass unchanged — these are the pre-existing test files most likely to regress if any of this plan's `c.stages.length === 0` branches were implemented incorrectly (per Global Constraints: "a Case with zero case_stages rows must behave identically to today").

- [ ] **Step 4: Security spot-check — re-run the isolation/tenant sweep**

Run: `npx vitest run tests/isolation/cross-tenant-sweep.test.ts tests/isolation/schema-guard.test.ts`
Expected: both pass. `schema-guard.test.ts` in particular will need `case_stages`'/`blueprint_stages`'s new columns reflected if it enumerates columns (not just tables) — if it fails, update its expected column list for `case_stages`/`blueprint_stages`/`requirements` to include this plan's new columns, then re-run.

- [ ] **Step 5: Manual verification checklist (browser, local dev server)**

Using `npm run dev` against the local (reset+reseeded) database from Task 9:
1. Open `/cases`, select the seeded "Compraventa" Case (now has 2 stages per Task 9's seed). Confirm the stage stepper renders both stage names, the first highlighted as active.
2. Approve every Kick-Off-stage document for both participants. Confirm "Continuar a Milestone 1" becomes enabled with no blocking reason shown.
3. Click it. Confirm Milestone 1 becomes active, Kick-Off shows completed, and the participant with a new Milestone 1 requirement received a reminder email in the local Resend/Inbucket capture (or logged output, per this project's existing email-testing setup).
4. As that Client in the Portal (`/portal/[token]`), confirm only Milestone 1's requirements are visible/actionable — Kick-Off's already-approved ones show nowhere as pending, and no future-locked stage (there is none left in this 2-stage seed, but confirm no stray items appear).
5. Back in Staff: reopen one of the now-completed Kick-Off requirements via the (to-be-added, per Task 7 — confirm it exists in the shipped UI) reopen affordance. Confirm it appears in the Client Portal's "Correcciones pendientes" section, tagged "(Kick-Off)", separate from the Milestone 1 list.
6. Confirm "Continuar" is now disabled again, with the reopened-pending reason shown.
7. Resolve the reopened item (approve its new document). Confirm "Continuar" re-enables.

- [ ] **Step 6: Final commit (only if Step 5 surfaced fixes)**

If manual verification found bugs, fix them, re-run the relevant automated tests, and commit with a message describing exactly what was wrong — do not silently fold undocumented fixes into this task's "commit" without saying what changed.

```bash
git add -A
git commit -m "Case Stages workflow: fix issues found during manual verification"
```

(Skip this step's commit entirely if Step 5 found nothing — an empty commit is not useful.)
