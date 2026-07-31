-- Reissuing a participant's invitation credential — shared by "Recordar" (staff, on demand) and
-- the automatic reminder cron (service_role), so there is exactly one implementation of "what does
-- issuing a fresh Portal link mean" rather than two runtimes independently generating and hashing
-- tokens and inevitably drifting apart (different TTL handling, different invalidation semantics,
-- different edge cases over time).
--
-- Conceptually this is the same operation as case-access/tokens.ts's generateInvitationToken(),
-- reimplemented once in SQL specifically so both callers (Next.js via the authenticated client,
-- the Deno Edge Function via the service-role client) can share this single definition instead of
-- each re-deriving their own. Next.js's own issueInvitation() (features/case-access/invitations.ts)
-- is untouched — it still handles the very first invitation, via a plain INSERT already covered by
-- the existing grants_insert_by_member policy. This function only ever UPDATEs an existing grant's
-- credential; it is never how a participant's first invitation is created.
--
-- Rotates ONLY invitation_token_hash. verified_at, revoked_at, auth_user_id, permission, and
-- expires_at are left completely untouched — a participant who already verified and has ongoing
-- access keeps that access exactly as it was; only the *unauthenticated landing* URL changes. The
-- previous token stops resolving immediately (its hash no longer matches any row), which is a
-- known, accepted tradeoff: a stale email opened after a newer one was sent shows a clear "this
-- link is no longer valid, use your most recent email" message rather than silently working.

create extension if not exists pgcrypto;

create or replace function public.emit_participant_invitation(p_participant_id uuid)
returns table (
  token text,
  invited_email text,
  case_id uuid,
  organization_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant_id uuid;
  v_invited_email text;
  v_case_id uuid;
  v_organization_id uuid;
  v_token text;
  v_token_hash text;
begin
  -- Two legitimate callers, checked explicitly since this runs as definer and bypasses RLS:
  -- the reminder cron's service-role client (no tenant context to check — it already selected
  -- this participant via its own due-reminder logic), or an authenticated staff member of the
  -- participant's own Organization (mirrors grants_update_by_member's own condition, since this
  -- function is effectively a narrowly-scoped UPDATE on that same table).
  if (select auth.role()) <> 'service_role' then
    if not exists (
      select 1
      from public.case_participants cp
      where cp.id = p_participant_id
        and cp.organization_id in (select app.member_org_ids())
    ) then
      raise exception 'not authorized to reissue this invitation';
    end if;
  end if;

  select g.id, g.invited_email, g.case_id, g.organization_id
    into v_grant_id, v_invited_email, v_case_id, v_organization_id
  from public.case_access_grants g
  where g.participant_id = p_participant_id
  order by g.created_at desc
  limit 1
  for update;

  if v_grant_id is null then
    raise exception 'no invitation exists yet for this participant';
  end if;

  -- Same shape as generateInvitationToken(): 32 CSPRNG bytes, base64url (no padding), SHA-256 hex
  -- digest of the token with no salt — 256 bits of entropy makes guessing the threat model, not a
  -- weak secret, so a fast constant-time-lookup hash is what the read path needs, not a slow one.
  -- translate() with fewer "to" characters than "from" drops the unmatched ones entirely, so this
  -- single call both substitutes the two base64 characters standard base64url swaps out AND strips
  -- the '=' padding standard base64url omits.
  -- Schema-qualified: search_path is '' in this function, and pgcrypto's functions live in the
  -- `extensions` schema on this project, not `public` — an unqualified call raises 42883.
  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  update public.case_access_grants
  set invitation_token_hash = v_token_hash
  where id = v_grant_id;

  return query select v_token, v_invited_email, v_case_id, v_organization_id;
end;
$$;

comment on function public.emit_participant_invitation(uuid) is
  'Rotates a participant''s invitation credential (token hash only — verified_at/revoked_at/auth_user_id/permission/expires_at untouched). Shared by the staff "Recordar" action and the reminder cron so both issue credentials identically.';

revoke all on function public.emit_participant_invitation(uuid) from public;
grant execute on function public.emit_participant_invitation(uuid) to authenticated, service_role;
