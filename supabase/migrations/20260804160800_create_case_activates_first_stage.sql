-- supabase/migrations/20260804160800_create_case_activates_first_stage.sql
--
-- Critical fix found during the production migration preflight, before this feature's own
-- migrations were ever pushed: create_case (last redefined in
-- 20260729120000_blueprint_participant_templates.sql) was never updated when this feature added
-- case_stages.status/completion_mode (20260804160000). Two real bugs, both in the same
-- case_stages clone step:
--
-- 1. The clone never set `status`, so every newly-cloned stage — including position 0 — defaulted
--    to 'locked' (the column default). advance_case_stage requires an 'active' stage to exist at
--    all (`no_active_stage` otherwise), so every Case created from a staged Blueprint after this
--    feature ships would have been permanently stuck with zero active stages and no way to ever
--    advance. This is the single most severe possible failure mode for this feature — worse than
--    any bug caught in the 10 tasks' own review rounds, because it would have made the feature
--    literally unusable for every new Case, not merely buggy in an edge case.
-- 2. The clone never selected `blueprint_stages.completion_mode`, so every cloned case_stages row
--    silently defaulted to 'requirements' regardless of what the Blueprint author configured in
--    the editor — completion_mode was designed to be "cloned from the Blueprint... From that
--    point forward the Case owns its own copy permanently" (design spec §3), not "always
--    'requirements'".

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
    -- Fix 2: clone completion_mode alongside name/position, not just the two original columns.
    insert into public.case_stages (organization_id, case_id, name, position, completion_mode)
    select target_organization_id, new_case_id, bs.name, bs.position, bs.completion_mode
    from public.blueprint_stages bs
    where bs.blueprint_id = from_blueprint_id
      and bs.organization_id = target_organization_id;

    -- Fix 1: activate the first stage (minimum position) — case_stages.status defaults to
    -- 'locked', so without this every cloned stage, including position 0, would stay locked
    -- forever and advance_case_stage would always raise no_active_stage. A Case with zero cloned
    -- stages (the Blueprint has no blueprint_stages rows) makes this UPDATE a no-op, which is
    -- correct: a stageless Case has nothing to activate.
    update public.case_stages
       set status = 'active', activated_at = now()
     where case_id = new_case_id
       and position = (
         select min(position) from public.case_stages where case_id = new_case_id
       );

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
