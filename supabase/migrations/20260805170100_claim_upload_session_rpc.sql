-- supabase/migrations/20260805170100_claim_upload_session_rpc.sql

create or replace function public.claim_upload_session_for_finalize(p_session_id uuid)
returns table (already_completed boolean, completed_document_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_session public.document_upload_sessions;
  v_lease_minutes constant integer := 5;
begin
  -- security definer (not invoker): this table has no update policy or grant at all for
  -- `authenticated` (Task 1 — "no insert/update/delete policy for any client role"; only
  -- service_role has write access), so an invoker-mode function running as the caller could not
  -- perform the UPDATEs below. This mirrors create_upload_session's own reasoning exactly.
  --
  -- Because security definer runs as the table owner and therefore bypasses RLS, the plain SELECT
  -- below must do EXPLICITLY what document_upload_sessions_select_own's RLS policy would have done
  -- implicitly under invoker mode: scope to `participant_id in (select
  -- app.granted_participant_ids('upload'))`. A caller with no active 'upload' grant on this
  -- session gets ZERO rows from this filtered SELECT, not an error, so v_org_id is null for BOTH
  -- "this session genuinely does not exist" and "it exists but isn't yours" — matching this
  -- codebase's own established precedent (getPortalCase's doc comment: "Returns null if the
  -- Participant row itself is not visible — the grant is not active, or belongs to someone else;
  -- both look identical, by design") and participant_stage_context's own security-definer-with-
  -- explicit-gate pattern. There is no separate not_authorized branch: this collapsed outcome IS
  -- the entire authorization model for a Participant's access to their own session.
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
  -- false "success" (already_completed: false) instead of erroring. Narrow, currently-unreachable
  -- race given nothing deletes these rows today, but the guard keeps this function's behavior
  -- honest against its own documented branches.
  if not found then
    raise exception using errcode = 'P0001', message = 'upload_session_not_found';
  end if;

  -- Deliberately the FIRST branch: a retry of an already-finished session returns its document id
  -- immediately, before anything else runs — including before finalizeUploadAction ever calls
  -- storage.info(). See design spec section 4.
  if v_session.status = 'completed' then
    return query select true, v_session.completed_document_id;
    return;
  end if;

  if v_session.status = 'finalizing' then
    if v_session.claimed_at > now() - make_interval(mins => v_lease_minutes) then
      raise exception using errcode = 'P0001', message = 'upload_finalize_in_progress';
    end if;
    -- Lease is stale: fall through and reclaim it as if it were 'pending'.
  elsif v_session.status = 'cancelled' then
    raise exception using errcode = 'P0001', message = 'upload_session_cancelled';
  elsif v_session.status = 'expired' then
    raise exception using errcode = 'P0001', message = 'upload_session_expired';
  elsif v_session.status <> 'pending' then
    -- Defensive: every other branch is covered above; this should be unreachable.
    raise exception using errcode = 'P0001', message = 'upload_session_not_pending';
  end if;

  -- Deliberately a check-and-raise only, NOT a check-and-persist: an UPDATE followed by an
  -- uncaught RAISE EXCEPTION in the same function invocation cannot leave the UPDATE committed —
  -- PostgREST wraps this whole RPC call in one transaction, and an error propagating out of the
  -- function aborts that entire transaction, rolling the UPDATE back right along with it (verified
  -- empirically while writing this migration; there is no plpgsql-only way around it short of a
  -- genuine autonomous transaction via dblink, which is disproportionate to this one field write
  -- and not how this codebase does things elsewhere). The Participant still gets the correct,
  -- immediate 'upload_session_expired' error either way; persisting the pending -> expired
  -- transition itself is the job of the separate app.expire_stale_pending_sessions() pg_cron
  -- function (design spec section "Lifecycle jobs", a later task) — this RPC does not race it or
  -- duplicate its responsibility, it only ever reads the row's current state.
  if v_session.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'upload_session_expired';
  end if;

  update public.document_upload_sessions
     set status = 'finalizing', claimed_at = now()
   where id = p_session_id;

  return query select false, null::uuid;
end;
$$;

revoke all on function public.claim_upload_session_for_finalize(uuid) from public;
grant execute on function public.claim_upload_session_for_finalize(uuid) to authenticated;
