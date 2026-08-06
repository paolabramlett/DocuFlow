-- supabase/migrations/20260805170300_cancel_upload_session_rpc.sql

create or replace function public.cancel_upload_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_status text;
begin
  -- security definer (not invoker): as claim_upload_session_for_finalize's and
  -- finalize_document_upload's own comments explain, document_upload_sessions has no update
  -- grant/policy at all for `authenticated` — only service_role can write it — so an
  -- invoker-mode function running as the caller could not perform this function's own UPDATE
  -- below (confirmed empirically while writing this migration).
  --
  -- Because security definer bypasses RLS, this first SELECT must do EXPLICITLY what
  -- document_upload_sessions_select_own's RLS policy would have done implicitly under invoker
  -- mode: scope to `participant_id in (select app.granted_participant_ids('upload'))`. A caller
  -- with no active 'upload' grant on this session gets ZERO rows, not an error, so v_org_id is
  -- null for both "this session genuinely does not exist" and "it exists but isn't yours" —
  -- same collapsed-outcome authorization model as the claim and finalize RPCs, no separate
  -- not_authorized branch.
  select organization_id into v_org_id
  from public.document_upload_sessions
  where id = p_session_id
    and participant_id in (select app.granted_participant_ids('upload'));
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

  select status into v_status from public.document_upload_sessions where id = p_session_id for update;

  -- Defensive: the row was visible to the plain SELECT above, but if it were somehow deleted
  -- between that SELECT and this FOR UPDATE, v_status would be NULL and every subsequent
  -- comparison below would silently evaluate false rather than erroring cleanly. Matches the
  -- guard already established in claim_upload_session_for_finalize.
  if not found then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

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
