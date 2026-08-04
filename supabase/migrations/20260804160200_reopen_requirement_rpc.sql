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

  if v_original.deleted_at is not null then
    raise exception using errcode = 'P0001', message = 'requirement_not_found';
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
