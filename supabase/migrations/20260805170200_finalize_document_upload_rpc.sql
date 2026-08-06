-- supabase/migrations/20260805170200_finalize_document_upload_rpc.sql

create or replace function public.finalize_document_upload(
  p_session_id uuid,
  p_verified_size_bytes bigint,
  p_verified_content_type text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_session public.document_upload_sessions;
  v_requirement public.requirements;
  v_grant_active boolean;
  v_case_state text;
begin
  -- security definer (not invoker): as claim_upload_session_for_finalize's own comment explains,
  -- document_upload_sessions has no update grant/policy at all for `authenticated` — only
  -- service_role can write it — so an invoker-mode function running as the caller could not
  -- perform this function's own final UPDATE. (Confirmed empirically while writing this
  -- migration: security invoker fails with "permission denied for table
  -- document_upload_sessions" on that UPDATE.)
  --
  -- Because security definer bypasses RLS, this first SELECT must do EXPLICITLY what
  -- document_upload_sessions_select_own's RLS policy would have done implicitly under invoker
  -- mode: scope to `participant_id in (select app.granted_participant_ids('upload'))`. A caller
  -- with no active 'upload' grant on this session gets ZERO rows, not an error, so v_org_id is
  -- null for both "this session genuinely does not exist" and "it exists but isn't yours" —
  -- same collapsed-outcome authorization model as the claim RPC, no separate not_authorized
  -- branch.
  select organization_id into v_org_id
  from public.document_upload_sessions
  where id = p_session_id
    and participant_id in (select app.granted_participant_ids('upload'));
  if v_org_id is null then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

  select * into v_session from public.document_upload_sessions where id = p_session_id for update;

  -- Live status check, not a trust-the-caller check: this is what makes a stale finalize attempt
  -- (reclaimed and re-finalized by someone else while this call was mid-flight) safe without a
  -- lease token. See design spec section 4's worked trace.
  if v_session.status <> 'finalizing' then
    raise exception using errcode = 'P0001', message = 'upload_session_not_finalizing';
  end if;

  -- Re-validate what could have changed during the upload's own wall-clock duration.
  select * into v_requirement from public.requirements where id = v_session.requirement_id for update;
  if v_requirement.status = 'satisfied' then
    raise exception using errcode = 'P0001', message = 'requirement_already_satisfied';
  end if;

  select
    (g.verified_at is not null and g.revoked_at is null and g.expires_at is not null
     and g.expires_at > now() and g.permission = 'upload')
    into v_grant_active
  from public.case_access_grants g
  where g.participant_id = v_session.participant_id
  order by g.created_at desc
  limit 1;
  if v_grant_active is not true then
    raise exception using errcode = 'P0001', message = 'grant_no_longer_active';
  end if;

  select state into v_case_state from public.cases where id = v_session.case_id;
  if v_case_state <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

  -- Replicates registerDocument's insert + audit shape directly in SQL, since this must run
  -- inside the same transaction/lock as the session's own completion. registerDocument (TS)
  -- itself is untouched and keeps serving whatever else calls it.
  insert into public.documents (
    id, organization_id, case_id, requirement_id, storage_path,
    file_name, content_type, size_bytes, uploaded_by_auth_user_id
  ) values (
    v_session.reserved_document_id, v_org_id, v_session.case_id, v_session.requirement_id,
    v_session.storage_path, v_session.original_file_name, p_verified_content_type,
    p_verified_size_bytes, (select auth.uid())
  );

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_org_id, v_session.case_id, 'document.uploaded', 'document', v_session.reserved_document_id,
    'client', (select auth.uid()),
    jsonb_build_object('fileName', v_session.original_file_name, 'contentType', p_verified_content_type, 'sizeBytes', p_verified_size_bytes)
  );

  update public.document_upload_sessions
     set status = 'completed', completed_at = now(), completed_document_id = v_session.reserved_document_id
   where id = p_session_id;

  return v_session.reserved_document_id;
end;
$$;

revoke all on function public.finalize_document_upload(uuid, bigint, text) from public;
grant execute on function public.finalize_document_upload(uuid, bigint, text) to authenticated;
