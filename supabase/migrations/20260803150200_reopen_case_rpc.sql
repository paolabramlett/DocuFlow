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
