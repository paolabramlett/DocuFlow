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
