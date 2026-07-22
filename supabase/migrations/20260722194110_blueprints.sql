-- Blueprints: the starting point of a Case, never a template that governs one.
--
-- Requirement definitions live here as inert jsonb rather than as a child table. Nothing
-- references them, nothing queries across them, and they exist only to be copied into real
-- `requirements` rows at clone time. A relational child table would buy integrity for rows that
-- have no relationships and would still be deep-copied on every clone.
--
-- Shape is validated by Zod at the server boundary; the CHECK here guarantees only that the
-- column is an array, so a malformed write cannot masquerade as a valid Blueprint.

create table public.blueprints (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,

  name text not null check (length(btrim(name)) between 1 and 200),
  description text check (length(description) <= 2000),

  requirement_definitions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(requirement_definitions) = 'array'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, organization_id)
);

create index blueprints_organization_id_idx on public.blueprints (organization_id);

create trigger blueprints_set_updated_at
  before update on public.blueprints
  for each row execute function app.set_updated_at();

alter table public.blueprints enable row level security;

-- Any Member reads Blueprints to create Cases from them; only Owners curate them
-- (organization-tenancy spec, "Only Owners manage the Organization and its membership").
create policy blueprints_select_own_org
  on public.blueprints
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy blueprints_insert_by_owner
  on public.blueprints
  for insert
  to authenticated
  with check (app.is_org_owner(organization_id));

create policy blueprints_update_by_owner
  on public.blueprints
  for update
  to authenticated
  using (app.is_org_owner(organization_id))
  with check (app.is_org_owner(organization_id));

create policy blueprints_delete_by_owner
  on public.blueprints
  for delete
  to authenticated
  using (app.is_org_owner(organization_id));

grant select, insert, update, delete on public.blueprints to authenticated;
grant all on public.blueprints to service_role;
