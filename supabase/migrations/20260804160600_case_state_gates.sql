-- supabase/migrations/20260804160600_case_state_gates.sql
--
-- Final-review fix wave. Five changes, none of which touch anything else in these RPCs' bodies:
--
-- 1. advance_case_stage, reopen_requirement, and assign_requirement_stage each gain a
--    `case_not_open` guard identical in spirit to close_case's own — a Staff member must not be
--    able to advance/reopen/assign on a Case that is 'completed' or 'cancelled'. The guard sits
--    AFTER the plain, non-locking authorization SELECT (so `not_authorized` still fires correctly
--    for a non-member caller before `case_not_open` does) and BEFORE any `FOR UPDATE` lock.
-- 2. assign_requirement_stage's read of the target case_stages row gains `for update`, closing a
--    real (low-probability) race with a concurrent advance_case_stage.
-- 3. list_actionable_requirement_ids gains a grant to service_role, for send.ts's admin-client
--    caller (fix #4).
-- 4. advance_case_stage's Gates 1 and 2 switch from `r.status = 'outstanding'` to
--    `r.status <> 'satisfied'`, matching Gate 3's existing predicate (fix #5, consistency/
--    defense-in-depth only — currently unreachable as a live bug).

-- ---------------------------------------------------------------------------------------------
-- advance_case_stage
-- ---------------------------------------------------------------------------------------------
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

  -- A closed Case (completed/cancelled) has no live workflow to advance: close_case's own trigger
  -- already downgraded every granted Client to 'view', so the client has no way to act on
  -- anything this would write. Same ordering as close_case's own case_not_open guard: after the
  -- plain authorization SELECT above, before any FOR UPDATE lock below.
  if (select state from public.cases where id = p_case_id) <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
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
  -- Parity with Gate 3 (and close_case's own convention): block on "not satisfied", not a positive
  -- match on 'outstanding' — requirements.status has three real values (outstanding, satisfied,
  -- archived), and 'archived' is not proof of completion either. Currently unreachable as a live
  -- bug (every writer of status = 'archived' also sets superseded_at, already filtered below), but
  -- kept consistent with Gate 3 for defense-in-depth.
  select count(*) into v_unassigned_count
  from public.requirements r
  where r.case_id = p_case_id
    and r.stage_id is null
    and r.participant_id is not null
    and r.status <> 'satisfied'
    and r.deleted_at is null
    and r.superseded_at is null;

  if v_unassigned_count > 0 then
    raise exception using errcode = 'P0001', message = 'unassigned_requirement_pending';
  end if;

  -- Gate 2: no pending reopened requirement anywhere in the Case, regardless of which stage it
  -- originally belonged to. Same "not satisfied" alignment as Gate 1 above.
  select count(*) into v_reopened_pending_count
  from public.requirements r
  where r.case_id = p_case_id
    and r.reopened_from_requirement_id is not null
    and r.status <> 'satisfied'
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
  -- Parity with close_case's own convention: block on "not satisfied" (count(*) filter (where
  -- r.status <> 'satisfied')), not a positive match on 'outstanding'. requirements.status has three
  -- real values (outstanding, satisfied, archived) — archived is NOT proof of completion, it still
  -- counts as outstanding here, exactly as close_case treats it. A positive match on 'outstanding'
  -- would let staff bypass "never auto-ready an empty requirements-mode stage" by archiving the one
  -- requirement instead of leaving it outstanding.
  select count(*), count(*) filter (where r.status <> 'satisfied')
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

-- ---------------------------------------------------------------------------------------------
-- reopen_requirement
-- ---------------------------------------------------------------------------------------------
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

  if v_original.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'requirement_not_found';
  end if;

  -- A closed Case (completed/cancelled) has no live workflow to correct: close_case's own trigger
  -- already downgraded every granted Client to 'view', so the client has no way to act on the new
  -- outstanding row this would create. v_original.case_id comes from the plain, non-locking read
  -- just above (this requirement's own FOR UPDATE, already justified above by its own
  -- authorization check) — no separate lookup of p_case_id is needed since this RPC takes the
  -- requirement id, not the case id.
  if (select state from public.cases where id = v_original.case_id) <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

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

-- ---------------------------------------------------------------------------------------------
-- assign_requirement_stage
-- ---------------------------------------------------------------------------------------------
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

  if v_req.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'requirement_not_found';
  end if;

  -- A closed Case (completed/cancelled) has no live workflow to assign into: close_case's own
  -- trigger already downgraded every granted Client to 'view', so the client has no way to act on
  -- the reassigned requirement. v_req comes from the plain, non-locking authorization read above,
  -- and case_id is stable on a requirement row, so this is safe to check here.
  if (select state from public.cases where id = v_req.case_id) <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

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

  -- FOR UPDATE: the requirement's own authorization was already established two statements above
  -- via the plain non-locking select, so locking this case_stages row now is safe. This prevents a
  -- concurrent advance_case_stage from flipping this stage from 'active' to 'completed' between
  -- this read and the update below — without the lock, this RPC could read 'active', have
  -- advance_case_stage complete the stage out from under it, and then move a requirement into a
  -- stage that is no longer actually active by the time the caller sees success.
  select * into v_stage from public.case_stages where id = p_stage_id and case_id = v_req.case_id for update;
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

-- ---------------------------------------------------------------------------------------------
-- list_actionable_requirement_ids: send.ts's reminder-email-body count (fix #4) calls this RPC
-- from an admin/service-role client, matching the rest of the reminder cron path. The underlying
-- app.actionable_requirement_ids already grants to service_role (20260804160400); this thin
-- public wrapper did not yet.
-- ---------------------------------------------------------------------------------------------
grant execute on function public.list_actionable_requirement_ids(uuid) to service_role;
