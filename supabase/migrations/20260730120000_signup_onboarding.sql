-- supabase/migrations/20260730120000_signup_onboarding.sql
--
-- Adds the write path for self-service signup: an atomic per-email cooldown claim, and a
-- dedicated, idempotent "complete the first onboarding" RPC — deliberately separate from
-- create_organization (see the function's own comment for why).

-- Cooldown-only anti-abuse for public signup. NOT anti-bot or anti-abuse protection on its own —
-- no per-IP limiting, no CAPTCHA, no pattern detection. Sufficient for MVP; expand if real abuse
-- appears. RLS enabled with zero policies: reachable only via the admin (service_role) client
-- inside signUpAction/claim_signup_attempt, never directly by anon/authenticated.
--
-- Retention: this is temporary operational state, not a historical record of signup attempts —
-- rows older than 7 days carry no ongoing purpose and should be purged periodically (a scheduled
-- job/cron script, out of scope for this migration to build, but the intent is documented here so
-- it doesn't quietly become an indefinite log of every email address that ever tried to sign up):
--   delete from public.signup_attempts where last_attempted_at < now() - interval '7 days';
create table public.signup_attempts (
  email text primary key,
  last_attempted_at timestamptz not null default now()
);
alter table public.signup_attempts enable row level security;

-- Atomic claim: a naive select-then-upsert is a genuine TOCTOU race (two concurrent requests
-- could both read "cooldown expired" before either writes). This makes the read-decide-write one
-- atomic operation via the UPSERT's own WHERE clause — only one concurrent caller for the same
-- email can ever see `claimed = true`.
create or replace function public.claim_signup_attempt(
  signup_email text,
  cooldown_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  -- Defensive validation: security definer, so it must not trust its own caller's parameters
  -- blindly even though only service_role can invoke it today.
  if nullif(btrim(signup_email), '') is null or length(signup_email) > 320 then
    raise exception 'invalid signup email' using errcode = '22023';
  end if;
  if cooldown_seconds < 1 or cooldown_seconds > 86400 then
    raise exception 'invalid cooldown' using errcode = '22023';
  end if;

  insert into public.signup_attempts (email, last_attempted_at)
  values (signup_email, now())
  on conflict (email) do update
    set last_attempted_at = excluded.last_attempted_at
    where public.signup_attempts.last_attempted_at
      <= now() - make_interval(secs => cooldown_seconds)
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_signup_attempt(text, integer) from public;
grant execute on function public.claim_signup_attempt(text, integer) to service_role;

-- Dedicated, idempotent first-onboarding RPC — deliberately NOT a modification of the existing
-- create_organization (which stays the generic, reusable "create an organization" capability with
-- no notion of "first" or "only"). Constraining create_organization itself to one-per-user would
-- silently break PRODUCT.md's "one identity, many organizations" model for any future "create an
-- additional organization" feature. This function owns exactly one concern: "has this identity
-- completed onboarding yet, and if not, do it atomically."
create or replace function public.complete_onboarding(
  organization_name text,
  organization_industry text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_organization_id uuid;
  new_organization_id uuid;
begin
  if current_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Serializes only concurrent onboarding calls for THIS identity. Does not constrain how many
  -- organizations a user may eventually belong to (members.unique(organization_id, user_id)
  -- stays exactly as-is). Released automatically on commit or rollback.
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  -- Multiple membership rows for one user are valid under the multi-organization model — not an
  -- anomaly to guard against. We only need to know whether onboarding already happened, and
  -- return a deterministic answer if so.
  select organization_id
  into existing_organization_id
  from public.members
  where user_id = current_user_id
  order by created_at asc
  limit 1;

  if existing_organization_id is not null then
    return existing_organization_id;
  end if;

  -- Defensive validation: this is security definer, callable by any authenticated user directly.
  -- Zod already validates in the Server Action; these mirror organizations' own CHECK constraints
  -- exactly (name 1-200 chars, industry the same 6-value enum already used by Settings).
  if nullif(btrim(organization_name), '') is null or length(btrim(organization_name)) > 200 then
    raise exception 'invalid organization name' using errcode = '22023';
  end if;
  if organization_industry not in ('notary', 'accounting', 'legal', 'insurance', 'hr', 'other') then
    raise exception 'invalid organization industry' using errcode = '22023';
  end if;

  insert into public.organizations (name, industry)
  values (btrim(organization_name), organization_industry)
  returning id into new_organization_id;

  insert into public.members (organization_id, user_id, role)
  values (new_organization_id, current_user_id, 'owner');

  return new_organization_id;
end;
$$;

revoke all on function public.complete_onboarding(text, text) from public;
grant execute on function public.complete_onboarding(text, text) to authenticated;
