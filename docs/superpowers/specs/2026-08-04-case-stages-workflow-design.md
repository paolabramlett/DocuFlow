# Case Stages Workflow — Design

**Goal:** Turn Blueprint/Case "stages" from an inert grouping label into a real sequential workflow that governs Case visibility, Staff actions, reminders, and the Client Portal — without regressing Cases that have no stages.

**Architecture:** `case_stages` gains a `status` (locked/active/completed) and `completion_mode` (requirements/manual), enforced by a partial-unique "one active stage per Case" index and an atomic `advance_case_stage` RPC. Requirement correction after approval reuses the existing supersede mechanism instead of mutating status on an already-reviewed row. A single SQL-level "actionable requirement" definition feeds both the reminder cron and the manual "Recordar" button, closing an existing drift bug as part of this feature.

**Tech Stack:** Postgres RPCs (`security invoker`/`security definer` as specified per-function below), Supabase RLS, Next.js Server Actions, existing Vitest integration-test conventions (`tests/isolation/`, `tests/integration/`).

## Global Constraints

- Every RPC error uses `raise exception using errcode = 'P0001', message = 'stable_snake_case_code'` (project-wide convention, see `close_case`/`reopen_case`).
- Authorization check (plain `select`, no lock) always precedes any `for update` row lock — RLS applies UPDATE-policy USING clauses to locked SELECTs (lesson from Case Closure).
- Emails are sent post-commit, best-effort, try/catch-logged, never blocking the transaction (Case Closure convention).
- Copy is Spanish (Mexico), matching the rest of the product.
- No Case ever loses data on this migration: legacy requirements/reviews/documents are never deleted or silently reinterpreted.

---

## 1. Current-state summary (from Fase 1 discovery — see conversation for full citations)

- `blueprint_stages`/`case_stages` exist today as normalized tables (`id, organization_id, blueprint_id|case_id, name, position, created_at`) with **no status/type column**. `create_case` deep-clones them correctly.
- `requirements.stage_id` is a real FK to `case_stages`, but is only populated for `scope: 'case'` requirements cloned via the `create_case` RPC. **Participant-scoped requirements — the majority of real usage — silently lose their `stage_position` today**, because `createCaseWithParticipants` calls `addRequirement` without `stageId`. This is fixed as part of this feature (§6).
- Nothing reads `stage_id`/`case_stages` today: not RLS, not triggers, not the reminder cron, not `emit_participant_invitation`, not the Staff Workspace, not the Client Portal.
- `requirements.status` has three real values: `outstanding | satisfied | archived`. There is no DB-level "rejected" state — it's inferred at read time from the latest review of the latest document.
- The automatic reminder cron (`status = 'outstanding'`) and the manual "Recordar" button (`status !== 'satisfied'`) have already drifted apart since `'archived'` was introduced — a pre-existing bug this feature must fix, not inherit.
- `requirements` already has a `superseded_at`/`superseded_by_requirement_id` append-only-correction mechanism (used when a document is re-uploaded after rejection). This feature reuses it rather than inventing a parallel "reopened" mutation.

## 2. Product decisions (confirmed, not open for renegotiation)

1. Exactly one active stage per Case (`locked | active | completed`).
2. Stages govern visibility: client sees only the active stage's requirements + individually-reopened earlier ones; Staff sees everything.
3. A single "Continuar a {next stage}" Staff action atomically completes the current stage, activates the next, and notifies only participants with newly actionable requirements.
4. Reopening an earlier-stage requirement never rolls back the stage; only that requirement re-enters "pending."
5. No "go back to a completed stage" action in the MVP.
6. Advancing is blocked by any pending/rejected active-stage requirement, or any pending reopened earlier requirement. No override.
7. The active stage is Case-global; per-participant progress within it is shown separately.
8. `completion_mode: requirements | manual` is included from the start, on both `blueprint_stages` and `case_stages` (cloned).
9. Two distinct progress calculations: `currentStageComplete` (gates advancing) and `workflowDocumentationComplete` (gates nothing by itself — informational; Case closure stays a separate, explicit Staff action).
10. Reminders (cron + manual) share exactly one actionable-requirement definition — never two.
11. The Client Portal shows only actionable items, not the whole Blueprint; future stages stay hidden.
12. Blueprint edits never affect already-cloned Case stages. No ad-hoc add/delete/reorder of a live Case's stages in this feature.
13. Backward compatible with: Cases with no stages, Blueprints with no stages, and pre-existing Cases (see §7 migration).

Confirmed refinements from review:

- **Cases without stages keep today's flat behavior exactly.** No virtual stage is ever created, visible, or persisted. The branch is explicit everywhere it matters: `case has stages → sequential workflow` vs. `case has no stages → legacy flat flow`. A Staff-facing label ("Sin workflow por etapas") may be shown; it is UI copy only, never a data row.
- **`workflowDocumentationComplete` requires ALL stages `completed`** (both `requirements` and `manual`), not just document-driven ones — otherwise the workflow could read "complete" while a manual stage is still active.
- **Legacy `stage_id = null` requirements inside a Case that *has* stages**: shown to Staff in an explicit "Sin etapa" bucket; shown to the client as actionable (compatibility); **block advancing the active stage** until Staff resolves or reassigns them (§6.3).
- **New requirements in a Case with stages never get a silent `stage_id = null`.** A Blueprint-derived requirement whose `stage_position` can't be resolved fails Case creation outright. A Staff-added ad hoc requirement must explicitly pick a stage or explicitly pick "sin etapa."

## 3. Schema

```sql
-- blueprint_stages
alter table public.blueprint_stages
  add column completion_mode text not null default 'requirements'
    check (completion_mode in ('requirements', 'manual'));

-- case_stages
alter table public.case_stages
  add column status text not null default 'locked'
    check (status in ('locked', 'active', 'completed')),
  add column completion_mode text not null default 'requirements'
    check (completion_mode in ('requirements', 'manual')),
  add column activated_at timestamptz,
  add column completed_at timestamptz,
  add column completed_by_auth_user_id uuid references auth.users(id);

-- at most one active stage per case
create unique index case_stages_one_active_per_case
  on public.case_stages (case_id) where status = 'active';

-- requirements: reopening is a NEW ROW, not a mutation of the approved one
alter table public.requirements
  add column reopened_from_requirement_id uuid references public.requirements(id),
  add column reopen_reason text check (reopen_reason is null or length(reopen_reason) <= 1000);
```

No `reopened_at`/`reopened_by_auth_user_id` mutation on the original row — see §4. The new row's own `created_at` and `superseded_by_requirement_id`-style linkage (via `reopened_from_requirement_id`, symmetric to the existing `superseded_by_requirement_id`) are sufficient; who reopened it is recoverable from the audit event written by `reopen_requirement` (§5).

## 4. Reopening a requirement — supersede, not status mutation (fix #1)

**Problem with the original draft:** setting `status = outstanding` on an already-`satisfied` row leaves its approved review and document attached; `deriveState` (which trusts `status = satisfied` first) would show `outstanding` while the latest review still says `approved` — a direct contradiction, and a violation of the append-only discipline already established for `superseded_at`/`superseded_by_requirement_id`.

**Fix:** `reopen_requirement` creates a brand-new `requirements` row and supersedes the original, using the exact mechanism `supersedeRequirement` already uses for re-uploads:

```sql
create or replace function public.reopen_requirement(p_requirement_id uuid, p_reason text)
returns uuid  -- new requirement id
language plpgsql security invoker set search_path = ''
as $$
declare
  v_org_id uuid;
  v_original public.requirements;
  v_new_id uuid;
begin
  -- authorization: plain select first, no lock (RLS UPDATE-policy-on-locked-read lesson)
  select organization_id into v_org_id
  from public.requirements
  where id = p_requirement_id;

  if v_org_id is null or v_org_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_original
  from public.requirements
  where id = p_requirement_id
  for update;

  if v_original.stage_id is null then
    raise exception using errcode = 'P0001', message = 'requirement_has_no_stage';
  end if;

  if (select status from public.case_stages where id = v_original.stage_id) <> 'completed' then
    raise exception using errcode = 'P0001', message = 'stage_not_completed';
  end if;

  if v_original.status <> 'satisfied' then
    raise exception using errcode = 'P0001', message = 'requirement_not_satisfied';
  end if;

  insert into public.requirements (
    organization_id, case_id, type, label, instructions, position, config,
    participant_id, stage_id, status, reopened_from_requirement_id, reopen_reason
  )
  values (
    v_original.organization_id, v_original.case_id, v_original.type, v_original.label,
    v_original.instructions, v_original.position, v_original.config,
    v_original.participant_id, v_original.stage_id, 'outstanding',
    v_original.id, p_reason
  )
  returning id into v_new_id;

  update public.requirements
  set superseded_at = now(), superseded_by_requirement_id = v_new_id
  where id = v_original.id;

  insert into public.audit_events (organization_id, case_id, actor_auth_user_id, event_type, payload)
  values (v_original.organization_id, v_original.case_id, auth.uid(), 'requirement_reopened',
    jsonb_build_object('original_requirement_id', v_original.id, 'new_requirement_id', v_new_id, 'reason', p_reason));

  return v_new_id;
end;
$$;
```

The original row keeps its approved review and document as untouched history (exactly like a normal supersede). The new row starts clean — no documents, no reviews — so `deriveState` naturally computes `pending`/`awaiting` for it with zero special-casing. "Pending reopened requirement" (used in §5 gating and §8 reminders) is now simply: `reopened_from_requirement_id is not null and status = 'outstanding'`.

Only allowed when the original requirement's stage is `completed` and the original is currently `satisfied` — reopening a still-`outstanding`/`rejected` requirement doesn't make sense (rejection already re-opens it via the existing review trigger), and reopening something in the active stage isn't "reopening" at all.

## 5. Stage state machine and advancement gate

`locked → active → completed`. First stage (min `position`) auto-activates when `create_case` clones stages for a Blueprint that has them.

**`currentStageComplete(caseId)`** — the advance gate — requires ALL of:

- Active stage readiness by `completion_mode`:
  - `requirements`: every client-visible active requirement in the stage (`participant_id is not null, deleted_at is null, superseded_at is null`) is `status = 'satisfied'`, **and at least one exists**.
  - `manual` (fix #3): **no client-visible requirement in the stage is currently `status = 'outstanding'`** (same non-empty-exempt check — a manual stage with zero requirements is trivially ready). `completion_mode: manual` changes *how readiness without client requirements is determined* (staff confirmation vs. requirement completion) — it never authorizes hiding pending client requirements. A manual stage that happens to accumulate client-visible requirements is gated exactly like a `requirements` stage on those.
- No pending reopened requirement anywhere in the Case (`reopened_from_requirement_id is not null and status = 'outstanding'`).
- No unassigned "Sin etapa" requirement pending in the Case (fix #4 — see §6.3): any `stage_id is null, participant_id is not null, status = 'outstanding', deleted_at is null, superseded_at is null` row blocks advancement until Staff resolves it via `assign_requirement_stage` or a normal review decision.

**`workflowDocumentationComplete(caseId)`** (informational only — never gates Case closure, which stays its own explicit action) requires ALL of:

- Every `case_stages` row for the Case has `status = 'completed'`.
- No pending reopened requirement anywhere in the Case.
- No client-visible `outstanding` requirement anywhere in a `completed` stage, independent of `reopened_from_requirement_id` (defensive — never trust a single flag to prove no debt exists, per review feedback).
- No unassigned "Sin etapa" requirement pending.

## 6. `advance_case_stage` RPC

```sql
create or replace function public.advance_case_stage(p_case_id uuid)
returns table(participant_id uuid)
language plpgsql security invoker set search_path = ''
as $$
declare
  v_org_id uuid;
  v_active public.case_stages;
  v_next public.case_stages;
begin
  select organization_id into v_org_id from public.cases where id = p_case_id;
  if v_org_id is null or v_org_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_active from public.case_stages
  where case_id = p_case_id and status = 'active'
  for update;

  if v_active.id is null then
    raise exception using errcode = 'P0001', message = 'no_active_stage';
  end if;

  -- readiness checks (requirements/manual per completion_mode, reopened-pending, unassigned-pending)
  -- raises 'stage_not_ready' | 'reopened_requirement_pending' | 'unassigned_requirement_pending'

  update public.case_stages
  set status = 'completed', completed_at = now(), completed_by_auth_user_id = auth.uid()
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

  insert into public.audit_events (organization_id, case_id, actor_auth_user_id, event_type, payload)
  values (v_org_id, p_case_id, auth.uid(), 'case_stage_advanced',
    jsonb_build_object('completed_stage_id', v_active.id, 'activated_stage_id', v_next.id));

  -- returns participants with a NEWLY ACTIONABLE requirement in v_next (fix #5, see below)
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
```

If there's no next stage (last stage completed), the function simply doesn't activate anything further and returns no rows — no auto-close of the Case, matching decision 3's explicit separation from Case Closure.

**Fix #5 — notification criterion tightened.** Original draft notified anyone with a *visible* requirement in the new stage. Corrected: only participants with a requirement that is *actionable* right now (`status = 'outstanding'`, client-visible, not deleted/superseded) in the newly-activated stage. A participant whose stage-2 requirement was already `satisfied` by legacy data, or whose next stage is `manual` with no client requirements at all, receives no email.

### 6.1 Fixing `createCaseWithParticipants` (fix — required, first task, not optional)

`src/application/create-case-with-participants.ts`'s loop over participant-scoped requirements must resolve `stage_position` the same way `create_case`'s SQL does and pass `stageId` to `addRequirement`:

1. For each Blueprint requirement definition with `scope: 'participant'`, read its `stage_position`.
2. Resolve it against the already-cloned `case_stages` for this Case (`case_id = ?, position = stage_position`).
3. If `stage_position` is set but no matching `case_stages` row exists → **fail Case creation** (`raise`/throw `stage_position_unresolved`), never fall back to `stage_id = null`.
4. If `stage_position` is absent (definition doesn't specify one) → `stage_id = null` is correct and expected (this Blueprint may not use stages, or this requirement is intentionally stageless).
5. Test coverage: participant-scoped requirements across multiple stages and multiple participants land on the correct `case_stages.id`.

### 6.2 `assign_requirement_stage` RPC (fix #4)

```sql
create or replace function public.assign_requirement_stage(p_requirement_id uuid, p_stage_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_org_id uuid;
  v_req public.requirements;
  v_stage public.case_stages;
begin
  select organization_id into v_org_id from public.requirements where id = p_requirement_id;
  if v_org_id is null or v_org_id not in (select app.member_org_ids()) then
    raise exception using errcode = 'P0001', message = 'not_authorized';
  end if;

  select * into v_req from public.requirements where id = p_requirement_id for update;

  if v_req.stage_id is not null then
    raise exception using errcode = 'P0001', message = 'requirement_already_assigned';
  end if;

  select * into v_stage from public.case_stages
  where id = p_stage_id and case_id = v_req.case_id;

  if v_stage.id is null then
    raise exception using errcode = 'P0001', message = 'stage_not_found';
  end if;

  -- MVP: only the active stage is a valid direct-assignment target.
  -- Assigning into a locked (future) stage isn't allowed from this quick-repair path —
  -- that would silently hide an already-actionable requirement from the client.
  -- Assigning into a completed stage isn't allowed either — use reopen_requirement's
  -- supersede path if the intent is "this belongs to a stage we've already finished."
  if v_stage.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'stage_not_active';
  end if;

  update public.requirements set stage_id = p_stage_id where id = p_requirement_id;

  insert into public.audit_events (organization_id, case_id, actor_auth_user_id, event_type, payload)
  values (v_org_id, v_req.case_id, auth.uid(), 'requirement_stage_assigned',
    jsonb_build_object('requirement_id', p_requirement_id, 'stage_id', p_stage_id));
end;
$$;
```

Server Action `assignRequirementStageAction(requirementId, stageId)` wraps this, following the existing `ActionResult<T>` convention (no `redirect()`, client does `router.refresh()` on success).

### 6.3 "Sin etapa" bucket — Staff UI contract

Any `requirements` row in a Case that has `case_stages` but `stage_id is null` renders in a dedicated "Sin etapa" section, always visible to Staff (not collapsed by default, unlike completed stages), with an inline "Asignar a etapa activa" action calling `assignRequirementStageAction`. This section is empty (and hidden) for the common case where no legacy gap exists.

## 7. `actionable_requirement_ids` — authorization fix (fix #2)

**Problem with the original draft:** `security definer` with no internal check, taking a bare `participant_id`, is a cross-tenant leak if ever granted to `authenticated`.

**Fix:** declare it `security invoker`, so it runs under the caller's own RLS session — the existing `requirements_select` policy (`organization_id in member_org_ids() or participant_id in granted_participant_ids('view')`) does the filtering for free, by construction, with no separate authorization logic to get wrong:

```sql
create or replace function app.actionable_requirement_ids(p_participant_id uuid)
returns setof uuid
language sql stable security invoker set search_path = ''
as $$
  select r.id
  from public.requirements r
  left join public.case_stages cs on cs.id = r.stage_id
  where r.participant_id = p_participant_id
    and r.deleted_at is null
    and r.superseded_at is null
    and r.status = 'outstanding'
    and (
      not exists (select 1 from public.case_stages s where s.case_id = r.case_id)
      or cs.status = 'active'
      or (cs.status = 'completed' and r.reopened_from_requirement_id is not null)
      or r.stage_id is null
    )
$$;
```

- Called by a Staff-authenticated Server Action (manual "Recordar"): the caller's own session RLS restricts results to their org — correct and sufficient, no special grant needed beyond ordinary `authenticated` execute.
- Called by the cron (`queue_reminders`, which already runs as an elevated/service context per its existing `security definer` wrapper): sees across all orgs, which is exactly what the cron needs to queue reminders for everyone. `EXECUTE` is granted to `authenticated` and `service_role`; **never** relied upon as a security boundary by itself — RLS is the boundary, as it is everywhere else in this schema.
- `eligible_reminders`'s existing `exists (...)` subquery is rewritten to call this same function (or an equivalent inlined join, since it runs inside a larger query) instead of its current bare `r.status = 'outstanding'` check, closing the cron/manual drift.
- `sendManualReminder`'s `hasOutstanding` TypeScript filter is replaced by a query that goes through this function (or a thin RPC wrapper `list_actionable_requirements(participant_id)` if a settable-returning function is more ergonomic to call from `supabase-js` than a bare function reference) — never reimplemented as a second predicate in TypeScript.

## 8. Portal messaging for a finished-but-open workflow

When `workflowDocumentationComplete(caseId) = true` but `cases.state = 'open'` (Case not yet explicitly closed), the Portal shows:

> "Workflow completo. No tienes acciones pendientes. El equipo continuará con el proceso."

This is deliberately distinct from the existing terminal-state ("expediente completado/cancelado") messaging, which only appears once Staff explicitly closes the Case — keeping the two concepts visibly separate to the client, matching decision 3's separation.

## 9. Migration & backfill (backfill preflight required — confirmed)

1. Schema migration (§3) ships with every new `case_stages` row defaulting `status = 'locked'`.
2. A **preflight check**, run manually against production before the backfill step: `select count(*) from case_stages where case_id in (select case_id from case_stages group by case_id)` (i.e., any Case with ≥1 `case_stages` row).
   - If the count is **zero** (expected — no seed data or real usage exercises this today, confirmed in Fase 1): the simple backfill runs safely — `update case_stages set status = 'active' where position = (select min(position) from case_stages cs2 where cs2.case_id = case_stages.case_id)`, and every other row stays `locked` (the column default).
   - If the count is **non-zero**: **abort the migration.** Do not guess a real Case's progress from data that was never tracked for this purpose (participant-scoped requirements' `stage_id` gaps make any inference unreliable, per §6.1's own finding). Produce a report of affected Case IDs for manual, case-by-case review before any backfill logic is written for that scenario. This decision point is called out explicitly in the plan (Fase 3) as a go/no-go gate, not something to code around silently.

## 10. Staff UI (contract, not final pixels)

- Stage stepper/timeline: completed stages collapsed by default (with a Staff-visible progress summary and any "Sin etapa"/reopened exceptions surfaced regardless of collapse), active stage expanded and highlighted, locked stages visibly present but inert.
- Per-participant progress inside the active stage (e.g. "Comprador 3/3 · listo").
- Primary action: "Continuar a {next stage name}" — disabled with an explicit reason string built from the specific gate that's failing (stage not ready / reopened pending / unassigned pending), never a generic "no disponible."
- "Recordar" is stage-contextual in its confirmation copy ("Recordar pendientes de {stage name}") but its underlying selection uses the same actionable-requirement source as everywhere else (§7) — it does not invent a stage-scoped variant of the predicate.
- "Sin etapa" section per §6.3.

## 11. Testing plan — mapped to existing infra

**Covered by existing jsdom+RTL infra (task #65)** — no new infrastructure needed:
- Stage stepper rendering (active/locked/completed visual states, collapsed/expanded).
- "Continuar" button enabled/disabled + reason text, mirroring `RequirementRow`'s existing gate-test pattern.
- "Sin etapa" section render/hide.
- Portal's "workflow completo, Case abierto" message vs. today's terminal-state banner — same pattern as `ClosureBanner`'s existing tests.

**Needs the existing `tests/integration/*` (node, real DB) pattern — no new infra, just more tests, same as `close_case`/`reopen_case`:**
- `advance_case_stage`: atomicity, single-active invariant enforcement, concurrency (two simultaneous advances can't skip a stage — same lock pattern proof as `close_case`), each gate (`stage_not_ready`, `reopened_requirement_pending`, `unassigned_requirement_pending`) individually, last-stage-completes-without-closing-case, correct audit payload, correct returned `participant_id` set (fix #5's tightened criterion).
- `reopen_requirement`: supersede correctness (original row untouched history, new row clean), `deriveState` on the new row, rejecting reopen on a non-completed stage / non-satisfied requirement, `reopened_from_requirement_id` propagation.
- `assign_requirement_stage`: happy path, rejects locked/completed target, rejects already-assigned requirement, tenant isolation.
- `actionable_requirement_ids` / the unified reminder selector: cron and manual paths return identical sets for the same fixture data (the actual regression test for the drift bug), excludes archived/deleted/superseded, excludes locked-stage requirements, includes reopened-pending, includes legacy stageless requirements.
- `createCaseWithParticipants` fix: participant-scoped requirements across multiple stages land on correct `stage_id`; unresolved `stage_position` fails Case creation (no silent null).
- Security: a Client session cannot call `advance_case_stage`/`reopen_requirement`/`assign_requirement_stage` (RLS/authorization check rejects); Participant A cannot read Participant B's `actionable_requirement_ids` results even indirectly.
- Compatibility: Case with zero `case_stages` rows behaves identically to today (flat, no gating, no "Continuar" button surface at all); Blueprint with zero `blueprint_stages`; a `requirements`-mode stage with zero requirements never auto-readies; a manual stage that later gets a client-visible requirement is gated on it exactly like a `requirements` stage.

## 12. Explicitly deferred (out of scope for this feature)

- Ad-hoc add/delete/reorder of a live Case's stages (decision 12).
- "Go back to a completed stage" (decision 5).
- Any override to advance with pending items (decision 6).
- Global/cross-org Blueprint stage catalog changes.
- Auto-closing a Case when the workflow finishes (stays a separate explicit action).
