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
  v_case_state text;
  v_actor_grant_id uuid;
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

  -- Defensive: the row was visible to the plain SELECT above, but if it were somehow deleted
  -- between that SELECT and this FOR UPDATE, v_session would be entirely NULL and every
  -- subsequent NULL-comparison branch below would silently evaluate false, falling through to a
  -- raw not-null-violation on the documents insert instead of erroring cleanly. Matches the guard
  -- already established in claim_upload_session_for_finalize and cancel_upload_session.
  if not found then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

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

  if v_session.participant_id not in (select app.granted_participant_ids('upload')) then
    raise exception using errcode = 'P0001', message = 'grant_no_longer_active';
  end if;

  select state into v_case_state from public.cases where id = v_session.case_id;
  if v_case_state <> 'open' then
    raise exception using errcode = 'P0001', message = 'case_not_open';
  end if;

  -- Defense-in-depth, mirroring create_upload_session's own exact checks (same literal values):
  -- this RPC is directly callable by `authenticated`, so p_verified_size_bytes/p_verified_content_type
  -- must be validated here too, not trusted from the caller. Before this pair of checks existed,
  -- an out-of-range size or a disallowed content type would have skipped straight to the
  -- `documents` insert below: `documents` itself carries no upper size bound and no content-type
  -- allow-list of its own, so any size and any content type would have silently succeeded and
  -- written a real row — not merely surfaced as a raw Postgres error under a different code.
  if p_verified_size_bytes <= 0 or p_verified_size_bytes > 26214400 then
    raise exception using errcode = 'P0001', message = 'file_too_large';
  end if;
  if p_verified_content_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp') then
    raise exception using errcode = 'P0001', message = 'content_type_not_allowed';
  end if;

  -- Defense-in-depth against a direct RPC call bypassing finalizeUpload's own (TS-layer)
  -- comparison of the Storage-reported content type against the session's declared one: this RPC
  -- is directly callable by `authenticated`, so a caller could otherwise pass any allow-listed
  -- p_verified_content_type regardless of what was actually declared at prepare time and what
  -- Storage actually reports. Mirrors design spec section 4/6's metadata-consistency requirement.
  if p_verified_content_type <> v_session.declared_content_type then
    raise exception using errcode = 'P0001', message = 'content_type_mismatch';
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

  -- recordAuditEvent (the retired path's audit writer) populates actor_grant_id for every client
  -- actor: `actor_grant_id: event.actor.kind === 'client' ? event.actor.grantId : null`. This RPC
  -- must resolve the equivalent id itself, using the exact same active-grant predicate as
  -- app.granted_participant_ids('upload') (verified/not revoked/not expired/upload permission),
  -- scoped to this session's own participant_id and the caller's own auth.uid().
  select id into v_actor_grant_id
  from public.case_access_grants
  where auth_user_id = (select auth.uid())
    and participant_id = v_session.participant_id
    and verified_at is not null
    and revoked_at is null
    and expires_at is not null
    and expires_at > now()
    and permission = 'upload'
  limit 1;

  -- The old path (registerDocument + recordAuditEvent) additionally emitted a SECOND
  -- document.uploaded event targeting the requirement (target_type: 'requirement', metadata:
  -- { replaced: true }). That event is deliberately NOT reproduced here: a repo-wide sweep found
  -- no reader of a requirement-targeted document.uploaded event today, so reintroducing an event
  -- with zero consumers was judged higher-risk (a second insert with no proven shape) than
  -- documenting its removal here. If a future feature needs to read Requirement-scoped upload
  -- history, it can query audit_events by (target_type = 'document', target_id) joined through
  -- documents.requirement_id instead of relying on a second, requirement-targeted row.
  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, actor_grant_id, metadata
  ) values (
    v_org_id, v_session.case_id, 'document.uploaded', 'document', v_session.reserved_document_id,
    'client', (select auth.uid()), v_actor_grant_id,
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
