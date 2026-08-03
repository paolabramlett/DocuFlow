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
