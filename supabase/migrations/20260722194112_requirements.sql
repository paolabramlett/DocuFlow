-- Requirements: what a Case needs before it can complete.
--
-- A document is one requirement type among peers, never the centre of the system (PRODUCT.md,
-- Positioning). The `type` discriminator carries every planned type from day one so that
-- enabling one later is a handler plus a trigger edit, not a structural migration.

create table public.requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,

  type text not null check (
    type in ('document', 'text', 'date', 'confirmation', 'payment', 'signature', 'form')
  ),

  label text not null check (length(btrim(label)) between 1 and 300),
  instructions text check (length(instructions) <= 4000),

  -- Explicit ordering, rewritten on reorder. Deliberately not unique per Case: a unique
  -- constraint would force deferred updates or temporary gaps on every drag.
  position integer not null check (position >= 0),

  -- Type-specific settings. Shape is owned by a versioned Zod schema per type at the server
  -- boundary; the CHECK guarantees only that it is an object.
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),

  status text not null default 'outstanding'
    check (status in ('outstanding', 'satisfied')),

  -- Soft delete. A deleted Requirement leaves the active Case but its history stays readable
  -- (case-workflow spec, "Deleting a requirement preserves the audit trail").
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade,

  unique (id, organization_id)
);

create index requirements_case_position_idx
  on public.requirements (case_id, position)
  where deleted_at is null;

create index requirements_organization_id_idx on public.requirements (organization_id);

create trigger requirements_set_updated_at
  before update on public.requirements
  for each row execute function app.set_updated_at();

-- Only `document` is implemented in this change. Enforced in the database rather than only at
-- the server boundary, because client-side authorization and validation are never trusted
-- (PRODUCT.md, Security constraints).
--
-- The list here is the planned-but-not-yet-built set, stated positively rather than as "anything
-- except document". That keeps two rejections distinct, which the spec relies on:
--
--   * a type outside the CHECK is invalid            -> check constraint violation
--   * a type inside the CHECK but unbuilt is pending -> explicit unsupported-type error
--
-- A BEFORE trigger fires ahead of constraint evaluation, so matching on the negative would
-- swallow genuinely invalid types and report them as merely unimplemented. Implementing a type
-- means removing it from this list.
create or replace function app.reject_unimplemented_requirement_type()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.type in ('text', 'date', 'confirmation', 'payment', 'signature', 'form') then
    raise exception 'unsupported requirement type: %', new.type
      using errcode = 'feature_not_supported',
            hint = 'Only document requirements are implemented in this release.';
  end if;

  return new;
end;
$$;

revoke all on function app.reject_unimplemented_requirement_type() from public;

create trigger requirements_reject_unimplemented_type
  before insert or update of type on public.requirements
  for each row execute function app.reject_unimplemented_requirement_type();

-- ---------------------------------------------------------------------------------------------
-- Active requirements view
-- ---------------------------------------------------------------------------------------------
--
-- Keeps the `deleted_at is null` filter in one place instead of in every caller, where a single
-- omission would silently resurrect deleted Requirements.
--
-- security_invoker is essential: a default view runs with its owner's privileges and would
-- bypass RLS on the underlying table entirely.

create view public.active_requirements
with (security_invoker = true)
as
select
  id,
  organization_id,
  case_id,
  type,
  label,
  instructions,
  position,
  config,
  status,
  created_at,
  updated_at
from public.requirements
where deleted_at is null;

-- ---------------------------------------------------------------------------------------------
-- Case creation and Blueprint cloning (design.md D6)
-- ---------------------------------------------------------------------------------------------
--
-- SECURITY INVOKER by design. Every insert below passes through the same RLS policies a direct
-- write would, so this convenience function cannot become a way around them.

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

  -- Deep copy: definitions become independent rows. No live reference remains, which is what
  -- makes later Blueprint edits unable to reach this Case.
  if from_blueprint_id is not null then
    insert into public.requirements (
      organization_id, case_id, type, label, instructions, position, config
    )
    select
      target_organization_id,
      new_case_id,
      coalesce(definition->>'type', 'document'),
      definition->>'label',
      definition->>'instructions',
      (ordinal - 1)::integer,
      coalesce(definition->'config', '{}'::jsonb)
    from public.blueprints b
    cross join lateral jsonb_array_elements(b.requirement_definitions)
      with ordinality as elements(definition, ordinal)
    where b.id = from_blueprint_id
      and b.organization_id = target_organization_id;
  end if;

  return new_case_id;
end;
$$;

comment on function public.create_case(uuid, uuid, text, uuid) is
  'Creates a Case, optionally deep-copying a Blueprint''s requirement definitions into it.';

revoke all on function public.create_case(uuid, uuid, text, uuid) from public;
grant execute on function public.create_case(uuid, uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.requirements enable row level security;

-- A granted Client sees the Requirements of their own Case, and only those.
create policy requirements_select
  on public.requirements
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or case_id in (select app.granted_case_ids('view'))
  );

create policy requirements_insert_by_member
  on public.requirements
  for insert
  to authenticated
  with check (organization_id in (select app.member_org_ids()));

create policy requirements_update_by_member
  on public.requirements
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

create policy requirements_delete_by_member
  on public.requirements
  for delete
  to authenticated
  using (organization_id in (select app.member_org_ids()));

grant select, insert, update, delete on public.requirements to authenticated;
grant select on public.active_requirements to authenticated;
grant all on public.requirements to service_role;
grant all on public.active_requirements to service_role;
