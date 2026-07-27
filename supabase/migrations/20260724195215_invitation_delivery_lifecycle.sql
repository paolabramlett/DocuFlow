-- Models invitation delivery as its own lifecycle, separate from grant access.
--
-- Two lifecycles now exist on case_access_grants, deliberately not merged:
--
--   * Invitation delivery — getting the client to accept:
--       pending -> sent -> failed -> accepted -> revoked
--     ("expired" is derived at read time from invitation_expires_at, never stored — the same
--     read-time-expiry philosophy as grant activity and reminder eligibility. No scheduled job
--     can leave a stale status sitting in the table.)
--
--   * Grant access — once accepted, governed by the existing verified_at / revoked_at /
--     expires_at / permission columns (design.md D3, D4). Untouched by this migration.
--
-- The two meet at exactly one point: acceptance. That transition is guarded by a trigger, not
-- application code, so it holds regardless of which caller writes verified_at or revoked_at —
-- the same reasoning as cases_reject_org_change and cases_downgrade_grants_on_completion.

alter table public.case_access_grants
  add column invitation_status text not null default 'pending'
    check (invitation_status in ('pending', 'sent', 'failed', 'accepted', 'revoked')),
  add column invitation_sent_at timestamptz,
  add column invitation_last_error text,
  -- The window to ACCEPT the invitation — distinct from otp_expiry (one code, 5 minutes) and
  -- from the grant's own expires_at (90-day TTL after acceptance). Generous by design: a client
  -- who does not open a fresh email in a week has practically lost the invitation.
  add column invitation_expires_at timestamptz not null default (now() + interval '7 days');

comment on column public.case_access_grants.invitation_status is
  'Delivery lifecycle: pending -> sent -> failed -> accepted -> revoked. Expired is derived, never stored.';
comment on column public.case_access_grants.invitation_expires_at is
  'Deadline to accept the invitation. Independent of otp_expiry and the post-acceptance grant TTL.';

-- Once verified_at or revoked_at is newly set — by any caller, application code or a direct
-- write — invitation_status is forced to match. This is the one place the two lifecycles are
-- stitched together.
--
-- Precedence, deliberately in this order:
--   1. 'revoked' is fully terminal — nothing follows it, ever.
--   2. Revocation wins even from 'accepted' — Staff revoking an active Client's access is a
--      normal, tested operation (revokeGrant), not a forbidden transition.
--   3. 'accepted' cannot otherwise be walked back to pending/sent/failed by anything.
--   4. Newly-set verified_at accepts, exactly once.
create or replace function app.sync_invitation_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.invitation_status = 'revoked' then
    new.invitation_status := 'revoked';
    return new;
  end if;

  if new.revoked_at is not null and old.revoked_at is null then
    new.invitation_status := 'revoked';
    return new;
  end if;

  if old.invitation_status = 'accepted' then
    new.invitation_status := 'accepted';
    return new;
  end if;

  if new.verified_at is not null and old.verified_at is null then
    new.invitation_status := 'accepted';
  end if;

  return new;
end;
$$;

comment on function app.sync_invitation_status() is
  'Forces invitation_status to accepted/revoked when verified_at/revoked_at is newly set. Revoked is terminal; revocation always wins, even from accepted.';

revoke all on function app.sync_invitation_status() from public;

create trigger grants_sync_invitation_status
  before update on public.case_access_grants
  for each row execute function app.sync_invitation_status();
