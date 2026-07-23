-- Blueprint and Case stages: first-class ordered entities (design.md D3).
--
-- Stages group Requirements (Documents -> Payment -> Signature). Blueprint stages are the template;
-- cloning deep-copies them into case stages and remaps each Requirement. A single default stage is
-- the degenerate path and needs no special handling.

create table public.blueprint_stages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  blueprint_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),

  foreign key (blueprint_id, organization_id)
    references public.blueprints (id, organization_id) on delete cascade,
  unique (id, organization_id)
);

create index blueprint_stages_blueprint_idx on public.blueprint_stages (blueprint_id, position);

create table public.case_stages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),

  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade,
  -- Referenced by requirements.stage_id, which must stay in the same Case and Organization.
  unique (id, case_id, organization_id),
  unique (id, organization_id)
);

create index case_stages_case_idx on public.case_stages (case_id, position);

alter table public.blueprint_stages enable row level security;
alter table public.case_stages enable row level security;

-- Blueprint stages follow blueprint visibility: any member reads, owners write.
create policy blueprint_stages_select_by_member
  on public.blueprint_stages for select to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy blueprint_stages_write_by_owner
  on public.blueprint_stages for all to authenticated
  using (app.is_org_owner(organization_id))
  with check (app.is_org_owner(organization_id));

-- Case stages: staff read/write. The client reaches stage grouping only through the requirements
-- assigned to their participant; stages carry no client-facing data on their own, so a staff-scoped
-- read is sufficient and simplest.
create policy case_stages_select_by_member
  on public.case_stages for select to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy case_stages_write_by_member
  on public.case_stages for all to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

grant select, insert, update, delete on public.blueprint_stages to authenticated;
grant select, insert, update, delete on public.case_stages to authenticated;
grant all on public.blueprint_stages to service_role;
grant all on public.case_stages to service_role;
