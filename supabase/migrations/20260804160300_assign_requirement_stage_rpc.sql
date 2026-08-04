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
