-- supabase/migrations/20260804160500_participant_stage_context.sql
--
-- The Client Portal needs each of a Participant's own Requirements' stage status/name (to exclude
-- locked-stage items and to show a reopened correction's ORIGINAL stage name), but case_stages'
-- only SELECT policy is staff-only (case_stages_select_by_member,
-- supabase/migrations/20260723151905_stages.sql) — an embedded PostgREST join from the Portal's
-- own (Participant) session silently resolves to null under RLS, never an error. This accessor
-- bridges that gap the same way app.actionable_requirement_ids does for reminders: security
-- definer, but explicitly gated against app.granted_participant_ids so it can never be used to
-- enumerate another participant's data.

create or replace function app.participant_stage_context(p_participant_id uuid)
returns table (requirement_id uuid, stage_status text, stage_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, cs.status, cs.name
  from public.requirements r
  join public.case_stages cs on cs.id = r.stage_id
  where r.participant_id = p_participant_id
    and p_participant_id in (select app.granted_participant_ids('view'))
$$;

comment on function app.participant_stage_context(uuid) is
  'Bridges case_stages'' staff-only RLS for the Client Portal: returns (requirement_id, stage_status,
   stage_name) for a Participant''s own Requirements only, explicitly re-checked against
   app.granted_participant_ids(''view'') so this security definer function can never be used to read
   another Participant''s stage context.';

revoke all on function app.participant_stage_context(uuid) from public;
-- security definer only changes execution-time rights, not invocation permission — the invoker
-- (the public wrapper below, itself security invoker) still needs its own EXECUTE grant to call
-- this function at all.
grant execute on function app.participant_stage_context(uuid) to authenticated;

-- Thin public-schema wrapper, same reasoning as public.list_actionable_requirement_ids (Task 6):
-- application code reaches app.* functions only through a public.* wrapper.
create or replace function public.list_participant_stage_context(p_participant_id uuid)
returns table (requirement_id uuid, stage_status text, stage_name text)
language sql
stable
security invoker
set search_path = ''
as $$
  select * from app.participant_stage_context(p_participant_id)
$$;

revoke all on function public.list_participant_stage_context(uuid) from public;
grant execute on function public.list_participant_stage_context(uuid) to authenticated;
