-- Blueprint Participant Templates: participants are part of a Blueprint's own domain model, not a
-- UI-only hint. Mirrors blueprint_stages exactly (composite FK, RLS shape, index pattern).
--
-- role_key is a stable, slug-formatted identifier ("buyer", "seller") — never the display label,
-- which can change or be translated. Requirement definitions reference it (see the accompanying
-- requirement_definitions shape change, enforced in application code, not a DB constraint, since
-- the column stays inert jsonb).

alter table public.blueprints
  add column is_platform_template boolean not null default false;

create table public.blueprint_participant_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  blueprint_id uuid not null,
  role_key text not null check (length(btrim(role_key)) between 1 and 100),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),

  foreign key (blueprint_id, organization_id)
    references public.blueprints (id, organization_id) on delete cascade,
  unique (id, organization_id),
  unique (blueprint_id, role_key)
);

create index blueprint_participant_templates_blueprint_idx
  on public.blueprint_participant_templates (blueprint_id, position);

alter table public.blueprint_participant_templates enable row level security;

create policy blueprint_participant_templates_select_by_member
  on public.blueprint_participant_templates for select to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy blueprint_participant_templates_write_by_owner
  on public.blueprint_participant_templates for all to authenticated
  using (app.is_org_owner(organization_id))
  with check (app.is_org_owner(organization_id));

grant select, insert, update, delete on public.blueprint_participant_templates to authenticated;
grant all on public.blueprint_participant_templates to service_role;

-- A duplicate stage position makes stage_position-based requirement mapping ambiguous, and
-- nothing currently prevents it. Verified safe: no existing test inserts two stages at the same
-- position for one Blueprint.
alter table public.blueprint_stages
  add constraint blueprint_stages_blueprint_id_position_key unique (blueprint_id, position);

-- create_case's requirement clone now excludes participant-scoped definitions from the case-level
-- checklist — they're created per-participant by createCaseWithParticipants instead (Task 4). This
-- is a last-resort backstop only: the strict query-layer validation (Task 3) is the real integrity
-- gate. A malformed scope value reaching this function directly is simply excluded from the
-- case-level clone, never thrown.
create or replace function public.create_case(
  target_organization_id uuid,
  target_client_id uuid,
  case_title text,
  from_blueprint_id uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_case_id uuid;
begin
  insert into public.cases (organization_id, client_id, title, origin_blueprint_id)
  values (target_organization_id, target_client_id, case_title, from_blueprint_id)
  returning id into new_case_id;

  if from_blueprint_id is not null then
    insert into public.case_stages (organization_id, case_id, name, position)
    select target_organization_id, new_case_id, bs.name, bs.position
    from public.blueprint_stages bs
    where bs.blueprint_id = from_blueprint_id
      and bs.organization_id = target_organization_id;

    insert into public.requirements (
      organization_id, case_id, type, label, instructions, position, config, stage_id
    )
    select
      target_organization_id,
      new_case_id,
      coalesce(definition->>'type', 'document'),
      definition->>'label',
      definition->>'instructions',
      (ordinal - 1)::integer,
      coalesce(definition->'config', '{}'::jsonb),
      cs.id
    from public.blueprints b
    cross join lateral jsonb_array_elements(b.requirement_definitions)
      with ordinality as elements(definition, ordinal)
    left join public.case_stages cs
      on cs.case_id = new_case_id
     and cs.position = (definition->>'stage_position')::integer
    where b.id = from_blueprint_id
      and b.organization_id = target_organization_id
      and coalesce(definition->>'scope', 'case') = 'case';
  end if;

  return new_case_id;
end;
$$;

revoke all on function public.create_case(uuid, uuid, text, uuid) from public;
grant execute on function public.create_case(uuid, uuid, text, uuid) to authenticated;
