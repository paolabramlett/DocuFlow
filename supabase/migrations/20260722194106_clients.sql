-- Clients: the durable, Organization-owned record of a person the Organization serves.
--
-- A Client is not a Case participant and not a login. It persists across every Case the
-- Organization runs for that person, and it never spans Organizations (PRODUCT.md, "One person,
-- many organizations"). Access to any individual Case is a separate grant, added in a later
-- migration.

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  full_name text not null check (length(btrim(full_name)) between 1 and 200),

  -- Stored lowercase so comparison is case-insensitive without the citext extension. The app
  -- normalizes at the boundary; this constraint is what makes that non-optional.
  email text not null check (
    email = lower(email)
    and position('@' in email) > 1
    and length(email) <= 320
  ),

  -- The link to a persistent passwordless identity, populated on first successful OTP
  -- verification. Nullable because Staff create Clients before the person has ever verified.
  --
  -- This is the ONLY permitted connection between tenants, and it grants nothing by itself:
  -- every read stays authorized by a Case Access grant, never by "same person" (design.md D1,
  -- client-identity spec). ON DELETE SET NULL so removing an auth identity never destroys the
  -- Organization's record of who it served.
  auth_user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Per-Organization, deliberately NOT global. A global unique index would leak cross-tenant
  -- presence through conflict errors: Organization B would learn that Organization A already
  -- serves this person. Cross-tenant existence is itself confidential.
  unique (organization_id, email),

  -- Carries the tenant into composite foreign keys from child rows (design.md D3).
  unique (id, organization_id)
);

create index clients_organization_id_idx on public.clients (organization_id);
create index clients_auth_user_id_idx on public.clients (auth_user_id) where auth_user_id is not null;

create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function app.set_updated_at();

alter table public.clients enable row level security;

-- Members of the owning Organization manage their own Clients. Clients themselves reach Case
-- data through grants, not through this table.
create policy clients_select_own_org
  on public.clients
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy clients_insert_own_org
  on public.clients
  for insert
  to authenticated
  with check (organization_id in (select app.member_org_ids()));

create policy clients_update_own_org
  on public.clients
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

create policy clients_delete_own_org
  on public.clients
  for delete
  to authenticated
  using (organization_id in (select app.member_org_ids()));

grant select, insert, update, delete on public.clients to authenticated;
grant all on public.clients to service_role;
