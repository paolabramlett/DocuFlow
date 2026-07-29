-- supabase/migrations/20260729130000_blueprint_authoring.sql
--
-- Adds the write path for Blueprints: a transactional save_blueprint RPC (create or full-replace
-- edit) plus the unique constraint that makes participant-template position load-bearing now that
-- a real write path exists (previously app-layer-only, per the prior spec's design note).

-- Guard first: adding the constraint below fails opaquely if any existing row already violates
-- it. This assertion turns that into a diagnosable migration error instead of a raw constraint
-- failure with no indication of which rows are at fault.
do $$
begin
  if exists (
    select 1
    from public.blueprint_participant_templates
    group by blueprint_id, position
    having count(*) > 1
  ) then
    raise exception 'Cannot add participant-template position constraint: duplicate positions exist';
  end if;
end;
$$;

alter table public.blueprint_participant_templates
  add constraint blueprint_participant_templates_blueprint_id_position_key unique (blueprint_id, position);

create or replace function public.save_blueprint(
  target_organization_id uuid,
  target_blueprint_id uuid,
  blueprint_name text,
  blueprint_description text,
  stages jsonb,
  participant_templates jsonb,
  requirement_definitions jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_blueprint_id uuid;
  existing_id uuid;
  bad_count int;
  stages_in jsonb := coalesce(stages, '[]'::jsonb);
  templates_in jsonb := coalesce(participant_templates, '[]'::jsonb);
  requirements_in jsonb := coalesce(requirement_definitions, '[]'::jsonb);
begin
  if not app.is_org_owner(target_organization_id) then
    raise exception using errcode = 'P0001', message = 'not_owner';
  end if;

  if jsonb_typeof(stages_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_stages_payload';
  end if;
  if jsonb_typeof(templates_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_participant_templates_payload';
  end if;
  if jsonb_typeof(requirements_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_requirements_payload';
  end if;

  if target_blueprint_id is not null then
    select id into existing_id
    from public.blueprints
    where id = target_blueprint_id
      and organization_id = target_organization_id
    for update;

    if existing_id is null then
      raise exception using errcode = 'P0001', message = 'blueprint_not_found';
    end if;
  end if;

  if blueprint_name is null or length(btrim(blueprint_name)) = 0 or length(btrim(blueprint_name)) > 200 then
    raise exception using errcode = 'P0001', message = 'invalid_blueprint_name';
  end if;
  if blueprint_description is not null and length(btrim(blueprint_description)) > 2000 then
    raise exception using errcode = 'P0001', message = 'invalid_blueprint_description';
  end if;

  if exists (
    select 1 from jsonb_array_elements(stages_in) elem
    where jsonb_typeof(elem) <> 'object'
       or elem->>'name' is null
       or length(btrim(elem->>'name')) = 0
       or length(btrim(elem->>'name')) > 200
       or elem->>'position' is null
       or elem->>'position' !~ '^[0-9]+$'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_stage_shape';
  end if;

  select count(*) into bad_count from (
    select (elem->>'position')::int as pos, count(*)
    from jsonb_array_elements(stages_in) elem
    group by pos having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_stage_position';
  end if;

  if exists (
    select 1 from jsonb_array_elements(templates_in) elem
    where jsonb_typeof(elem) <> 'object'
       or elem->>'role_key' is null
       or length(elem->>'role_key') > 100
       or elem->>'role_key' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       or elem->>'display_name' is null
       or length(btrim(elem->>'display_name')) = 0
       or length(btrim(elem->>'display_name')) > 200
       or elem->>'position' is null
       or elem->>'position' !~ '^[0-9]+$'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_participant_template_shape';
  end if;

  select count(*) into bad_count from (
    select elem->>'role_key' as rk, count(*)
    from jsonb_array_elements(templates_in) elem
    group by rk having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_participant_role_key';
  end if;

  select count(*) into bad_count from (
    select (elem->>'position')::int as pos, count(*)
    from jsonb_array_elements(templates_in) elem
    group by pos having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_participant_position';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requirements_in) req
    where jsonb_typeof(req) <> 'object'
       or req->>'key' is null
       or length(req->>'key') > 200
       or req->>'key' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       or req->>'type' is null
       or length(btrim(req->>'type')) = 0
       or length(btrim(req->>'type')) > 100
       or req->>'label' is null
       or length(btrim(req->>'label')) = 0
       or length(btrim(req->>'label')) > 300
       or (req->>'instructions' is not null and length(req->>'instructions') > 2000)
       or req->>'scope' is null
       or req->>'scope' not in ('case', 'participant')
       or (req->>'scope' = 'participant' and (req->>'participant_role_key' is null or length(btrim(req->>'participant_role_key')) = 0))
       or (req->>'scope' = 'case' and req->>'participant_role_key' is not null)
       or (
         req->>'stage_position' is not null
         and req->>'stage_position' !~ '^[0-9]+$'
       )
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_requirement_shape';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requirements_in) req
    where req->>'scope' = 'participant'
      and not exists (
        select 1 from jsonb_array_elements(templates_in) t
        where t->>'role_key' = req->>'participant_role_key'
      )
  ) then
    raise exception using errcode = 'P0001', message = 'unknown_participant_role_key';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requirements_in) req
    where req->>'stage_position' is not null
      and not exists (
        select 1 from jsonb_array_elements(stages_in) s
        where (s->>'position')::int = (req->>'stage_position')::int
      )
  ) then
    raise exception using errcode = 'P0001', message = 'unknown_stage_position';
  end if;

  select count(*) into bad_count from (
    select
      case when req->>'scope' = 'case' then 'case' else 'participant:' || (req->>'participant_role_key') end as bucket,
      req->>'key' as k,
      count(*)
    from jsonb_array_elements(requirements_in) req
    group by bucket, k having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_requirement_key';
  end if;

  if target_blueprint_id is null then
    insert into public.blueprints (organization_id, name, description, requirement_definitions)
    values (
      target_organization_id,
      btrim(blueprint_name),
      nullif(btrim(coalesce(blueprint_description, '')), ''),
      requirements_in
    )
    returning id into new_blueprint_id;
  else
    new_blueprint_id := target_blueprint_id;

    delete from public.blueprint_participant_templates
    where blueprint_id = target_blueprint_id and organization_id = target_organization_id;

    delete from public.blueprint_stages
    where blueprint_id = target_blueprint_id and organization_id = target_organization_id;
  end if;

  insert into public.blueprint_stages (organization_id, blueprint_id, name, position)
  select target_organization_id, new_blueprint_id, elem->>'name', (elem->>'position')::int
  from jsonb_array_elements(stages_in) elem;

  insert into public.blueprint_participant_templates (organization_id, blueprint_id, role_key, display_name, position)
  select target_organization_id, new_blueprint_id, elem->>'role_key', elem->>'display_name', (elem->>'position')::int
  from jsonb_array_elements(templates_in) elem;

  if target_blueprint_id is not null then
    -- Not setting updated_at explicitly here: public.blueprints already carries a
    -- `before update` trigger (blueprints_set_updated_at, from the original blueprints
    -- migration) that stamps it on every update. Setting it again here would be redundant.
    update public.blueprints
    set name = btrim(blueprint_name),
        description = nullif(btrim(coalesce(blueprint_description, '')), ''),
        requirement_definitions = requirements_in
    where id = target_blueprint_id and organization_id = target_organization_id;

    if not found then
      raise exception using errcode = 'P0001', message = 'blueprint_not_found';
    end if;
  end if;

  return new_blueprint_id;
end;
$$;

revoke all on function public.save_blueprint(uuid, uuid, text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.save_blueprint(uuid, uuid, text, text, jsonb, jsonb, jsonb) to authenticated;
