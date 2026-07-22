-- Cases and Case Access grants, plus the resolver that spans them.
--
-- These ship together because they are mutually dependent: a Case policy must let a granted
-- Client read their own Case, so it needs the grant resolver, which needs the grant table, which
-- references the Case table. Table, table, resolver, policies — in that order.

-- ---------------------------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------------------------

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null,

  -- Provenance only. Nothing reads this during Case operation, and ON DELETE SET NULL means
  -- deleting a Blueprint leaves cloned Cases fully intact (case-workflow spec).
  origin_blueprint_id uuid references public.blueprints (id) on delete set null,

  title text not null check (length(btrim(title)) between 1 and 300),

  state text not null default 'open' check (state in ('open', 'completed', 'cancelled')),
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Denormalized organization_id cannot drift from the Client's: the composite key makes a
  -- mismatched row unrepresentable rather than merely discouraged (design.md D3).
  foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,

  unique (id, organization_id),

  constraint cases_completed_at_matches_state check (
    (state = 'completed') = (completed_at is not null)
  )
);

create index cases_organization_id_idx on public.cases (organization_id);
create index cases_client_id_idx on public.cases (client_id);

create trigger cases_set_updated_at
  before update on public.cases
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Case Access grants
-- ---------------------------------------------------------------------------------------------

create table public.case_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  client_id uuid not null,

  -- Bound on verification. Policy evaluation matches on this, never on the email address, so a
  -- mailbox alone is not authorization (case-access spec).
  auth_user_id uuid references auth.users (id) on delete cascade,

  invited_email text not null check (
    invited_email = lower(invited_email)
    and position('@' in invited_email) > 1
    and length(invited_email) <= 320
  ),

  -- The invitation token is stored hashed, never in the clear. A database disclosure therefore
  -- leaks no usable invitations. The token itself identifies Case context only and grants
  -- nothing without OTP verification of the invited mailbox (design.md D5).
  invitation_token_hash text not null unique,

  -- Permission is independent of lifecycle state: both are evaluated, neither implies the other
  -- (design.md D4). Ordering is none < view < upload.
  permission text not null default 'upload'
    check (permission in ('upload', 'view', 'none')),

  verified_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz,

  -- OTP throttling. Kept on the grant rather than in a side table because the grant is already
  -- the thing being attacked, and a lock that outlives the grant would serve no one. The
  -- submitted code is never stored, only the fact that an attempt happened.
  otp_last_sent_at timestamptz,
  otp_failed_attempts integer not null default 0 check (otp_failed_attempts >= 0),
  otp_locked_until timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade,
  foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete cascade,

  -- A verified grant always carries the identity it was bound to and a expiry it was given.
  constraint grants_verified_is_complete check (
    verified_at is null
    or (auth_user_id is not null and expires_at is not null)
  )
);

-- Carries the read-time activity predicate: identity, then the three lifecycle columns.
create index grants_auth_user_active_idx
  on public.case_access_grants (auth_user_id, expires_at)
  where verified_at is not null and revoked_at is null;

create index grants_case_id_idx on public.case_access_grants (case_id);
create index grants_client_id_idx on public.case_access_grants (client_id);

create trigger grants_set_updated_at
  before update on public.case_access_grants
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Grant resolver (design.md D2)
-- ---------------------------------------------------------------------------------------------
--
-- SECURITY-CRITICAL — same rules as app.member_org_ids(): no dynamic SQL, pinned search_path,
-- STABLE, and it answers exactly one question.
--
-- Expiry is evaluated here, at read time, rather than by a scheduled job. A cron that fails to
-- run would leave access open; a predicate that fails to run returns no rows. The failure mode
-- of this design is denial, which is the correct direction (design.md, Risks).

create or replace function app.granted_case_ids(min_permission text default 'view')
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select g.case_id
  from public.case_access_grants g
  where g.auth_user_id = (select auth.uid())
    and g.verified_at is not null
    and g.revoked_at is null
    and g.expires_at is not null
    and g.expires_at > now()
    and case min_permission
          when 'view' then g.permission in ('view', 'upload')
          when 'upload' then g.permission = 'upload'
          else false
        end
$$;

comment on function app.granted_case_ids(text) is
  'SECURITY-CRITICAL. Cases the current user holds an active grant on at or above min_permission.';

revoke all on function app.granted_case_ids(text) from public;
grant execute on function app.granted_case_ids(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Case completion downgrades access (design.md D4, R2)
-- ---------------------------------------------------------------------------------------------
--
-- Reads the owning Organization's retention policy rather than a constant, so a different
-- retention period is a different row value and never a code change.

create or replace function app.downgrade_grants_on_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  retention_days integer;
begin
  if new.state = 'completed' and old.state is distinct from 'completed' then
    select o.access_retention_days
      into retention_days
      from public.organizations o
     where o.id = new.organization_id;

    update public.case_access_grants g
       set permission = 'view',
           expires_at = now() + make_interval(days => retention_days)
     where g.case_id = new.id
       and g.revoked_at is null;
  end if;

  return new;
end;
$$;

comment on function app.downgrade_grants_on_completion() is
  'On Case completion, downgrades active grants to view for the Organization retention window.';

revoke all on function app.downgrade_grants_on_completion() from public;

create trigger cases_downgrade_grants_on_completion
  after update of state on public.cases
  for each row execute function app.downgrade_grants_on_completion();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.cases enable row level security;
alter table public.case_access_grants enable row level security;

-- Cases -----------------------------------------------------------------------------------------
--
-- Two principals, composed: a Member of the owning Organization, or a Client holding an active
-- grant on this specific Case. The grant clause is scoped to `id`, so it never widens to a
-- sibling Case of the same Client.

create policy cases_select
  on public.cases
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or id in (select app.granted_case_ids('view'))
  );

create policy cases_insert_by_member
  on public.cases
  for insert
  to authenticated
  with check (organization_id in (select app.member_org_ids()));

create policy cases_update_by_member
  on public.cases
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

create policy cases_delete_by_member
  on public.cases
  for delete
  to authenticated
  using (organization_id in (select app.member_org_ids()));

-- Grants ----------------------------------------------------------------------------------------
--
-- Clients may read their own grant, and nothing else about it. They never write one: issuance,
-- permission changes, and revocation are Staff actions.

create policy grants_select
  on public.case_access_grants
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or auth_user_id = (select auth.uid())
  );

create policy grants_insert_by_member
  on public.case_access_grants
  for insert
  to authenticated
  with check (organization_id in (select app.member_org_ids()));

create policy grants_update_by_member
  on public.case_access_grants
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

create policy grants_delete_by_member
  on public.case_access_grants
  for delete
  to authenticated
  using (organization_id in (select app.member_org_ids()));

grant select, insert, update, delete on public.cases to authenticated;
grant select, insert, update, delete on public.case_access_grants to authenticated;
grant all on public.cases to service_role;
grant all on public.case_access_grants to service_role;
