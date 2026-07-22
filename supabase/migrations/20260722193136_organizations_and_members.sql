-- Organizations, Members, and the authorization resolvers every later policy is built on.
--
-- Order inside this file is deliberate and load-bearing: tables, then resolvers that read them,
-- then policies that call the resolvers. RLS is enabled with the table, and an RLS-enabled table
-- with no policy denies everything, so nothing is exposed while the file is mid-flight.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),

  -- Industry drives default terminology, starter Blueprints, contextual help, and examples.
  -- It must never branch engine behaviour (PRODUCT.md, Operating Context). A CHECK rather than
  -- an enum: adding an industry should be a one-line constraint change, not a type migration.
  industry text not null check (
    industry in ('notary', 'accounting', 'legal', 'insurance', 'hr', 'other')
  ),

  -- design.md R2: the post-completion read-only window, per Organization rather than hardcoded.
  -- Not surfaced in the MVP UI; the column exists so a later release can expose it without a
  -- schema change or any change to grant logic.
  access_retention_days integer not null default 90
    check (access_retention_days between 1 and 3650),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.organizations.access_retention_days is
  'Days a completed Case stays readable to its Client before access closes. Default 90.';

create table public.members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One membership per user per Organization. The same human may hold rows in many
  -- Organizations; each is independent and confers nothing on the others.
  unique (organization_id, user_id)
);

-- The resolvers filter by user_id on every request; this index carries that lookup.
create index members_user_id_idx on public.members (user_id);
create index members_organization_id_idx on public.members (organization_id);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function app.set_updated_at();

create trigger members_set_updated_at
  before update on public.members
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Authorization resolvers (design.md D1, D2)
-- ---------------------------------------------------------------------------------------------
--
-- SECURITY-CRITICAL. These functions are the privilege boundary of the entire system: they run
-- as their owner and therefore see every row, and a defect here is a cross-tenant breach rather
-- than a bug. Rules for changing them:
--
--   * no dynamic SQL, ever;
--   * `search_path` stays pinned to '' and every name stays schema-qualified;
--   * STABLE, so the planner evaluates them once per statement rather than once per row;
--   * they answer "which tenants/cases is the caller entitled to", nothing else.
--
-- SECURITY DEFINER is also what makes a policy on `members` possible at all. A policy that
-- queried `members` directly would re-enter its own policy and recurse; the function bypasses
-- RLS internally and breaks the cycle. For the same reason `members` must never be switched to
-- FORCE ROW LEVEL SECURITY, which would subject the owner to policies and restore the recursion.

create or replace function app.member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.organization_id
  from public.members m
  where m.user_id = (select auth.uid())
$$;

comment on function app.member_org_ids() is
  'SECURITY-CRITICAL. Organizations the current user is a Member of. Used by every tenant policy.';

create or replace function app.is_org_owner(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.members m
    where m.user_id = (select auth.uid())
      and m.organization_id = target_organization_id
      and m.role = 'owner'
  )
$$;

comment on function app.is_org_owner(uuid) is
  'SECURITY-CRITICAL. Whether the current user owns the given Organization.';

-- Execute is granted to the authenticated role only. `anon` never resolves membership: an
-- unauthenticated caller has no tenant, and the invitation flow deliberately returns no
-- tenant data before OTP verification.
revoke all on function app.member_org_ids() from public;
revoke all on function app.is_org_owner(uuid) from public;
grant execute on function app.member_org_ids() to authenticated;
grant execute on function app.is_org_owner(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Onboarding
-- ---------------------------------------------------------------------------------------------
--
-- Organization creation is a bootstrap problem: the caller cannot be an owner of a row that does
-- not exist yet, so no INSERT policy on `organizations` could express it without opening blanket
-- insert. This function creates the Organization and its first owner Member in one transaction,
-- and is the only path that inserts an Organization.

create or replace function public.create_organization(
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
  new_organization_id uuid;
begin
  if current_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  insert into public.organizations (name, industry)
  values (organization_name, organization_industry)
  returning id into new_organization_id;

  insert into public.members (organization_id, user_id, role)
  values (new_organization_id, current_user_id, 'owner');

  return new_organization_id;
end;
$$;

comment on function public.create_organization(text, text) is
  'Creates an Organization and makes the caller its first owner. The only path that inserts an Organization.';

revoke all on function public.create_organization(text, text) from public;
grant execute on function public.create_organization(text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.members enable row level security;

-- Organizations ---------------------------------------------------------------------------------

create policy organizations_select_own
  on public.organizations
  for select
  to authenticated
  using (id in (select app.member_org_ids()));

create policy organizations_update_by_owner
  on public.organizations
  for update
  to authenticated
  using (app.is_org_owner(id))
  with check (app.is_org_owner(id));

-- No INSERT policy: creation goes through public.create_organization().
-- No DELETE policy: Organizations are not deleted through the API.

-- Members ---------------------------------------------------------------------------------------

create policy members_select_own_orgs
  on public.members
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy members_insert_by_owner
  on public.members
  for insert
  to authenticated
  with check (app.is_org_owner(organization_id));

-- USING gates which rows may be targeted; WITH CHECK gates the result. Both are required, or an
-- owner could move a Member row into another Organization.
create policy members_update_by_owner
  on public.members
  for update
  to authenticated
  using (app.is_org_owner(organization_id))
  with check (app.is_org_owner(organization_id));

create policy members_delete_by_owner
  on public.members
  for delete
  to authenticated
  using (app.is_org_owner(organization_id));

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
--
-- This Supabase version does not auto-expose new tables to the API roles, so every privilege is
-- named here. A forgotten grant fails closed. RLS then narrows what these grants can reach.

grant select, update on public.organizations to authenticated;
grant select, insert, update, delete on public.members to authenticated;

grant all on public.organizations to service_role;
grant all on public.members to service_role;
