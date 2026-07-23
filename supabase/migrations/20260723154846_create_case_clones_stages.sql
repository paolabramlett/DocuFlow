-- create_case now deep-copies Blueprint Stages into Case Stages and maps each cloned Requirement
-- to its Stage (design.md D3, case-stages spec).
--
-- Blueprint requirement definitions may carry an optional "stage_position" pointing at the
-- Blueprint Stage they belong to; the clone remaps that to the freshly-created Case Stage at the
-- same position. Definitions without one land with no Stage (the single-default-stage path).
--
-- SECURITY INVOKER (default): every insert passes through RLS as the acting member, so this
-- convenience function cannot bypass the policies.

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
    -- Deep-copy stages first, so requirements can map to them.
    insert into public.case_stages (organization_id, case_id, name, position)
    select target_organization_id, new_case_id, bs.name, bs.position
    from public.blueprint_stages bs
    where bs.blueprint_id = from_blueprint_id
      and bs.organization_id = target_organization_id;

    -- Deep-copy requirement definitions, mapping each to the cloned stage by position. A
    -- definition without a stage_position maps to no stage (left join yields null).
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
      and b.organization_id = target_organization_id;
  end if;

  return new_case_id;
end;
$$;

revoke all on function public.create_case(uuid, uuid, text, uuid) from public;
grant execute on function public.create_case(uuid, uuid, text, uuid) to authenticated;
