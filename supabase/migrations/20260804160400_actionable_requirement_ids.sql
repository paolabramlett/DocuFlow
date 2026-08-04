-- The single, shared definition of "this Requirement is actionable right now for this
-- Participant" — used by both the automatic reminder cron and the manual "Recordar" button, so
-- they can never drift again the way they already had (the cron used status = 'outstanding'; the
-- manual path used status <> 'satisfied', which silently diverged once 'archived' became a valid
-- status value).
--
-- security invoker (not definer): runs under the caller's own RLS session. A Staff-authenticated
-- caller is restricted to their own org by requirements_select's existing policy; the reminder
-- cron (queue_reminders, already security definer) sees across every org, which is exactly what
-- it needs. RLS is the security boundary here, as everywhere else in this schema — this function
-- adds no authorization logic of its own to get wrong.
create or replace function app.actionable_requirement_ids(p_participant_id uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id
  from public.requirements r
  left join public.case_stages cs on cs.id = r.stage_id
  where r.participant_id = p_participant_id
    and r.deleted_at is null
    and r.superseded_at is null
    and r.status = 'outstanding'
    and (
      -- Case has no case_stages rows at all: legacy flat behavior, everything outstanding is
      -- actionable.
      not exists (select 1 from public.case_stages s where s.case_id = r.case_id)
      -- The requirement's own stage is the currently active one.
      or cs.status = 'active'
      -- The requirement's stage is completed, but this specific requirement was reopened and is
      -- still pending correction.
      or (cs.status = 'completed' and r.reopened_from_requirement_id is not null)
      -- Legacy "Sin etapa" requirement in a Case that does have stages: shown to the client as
      -- actionable for compatibility (design spec §2, "Legacy stage_id = null requirements").
      or r.stage_id is null
    )
$$;

comment on function app.actionable_requirement_ids(uuid) is
  'The one shared definition of "actionable now" for a Participant''s Requirements. Used by both
   app.eligible_reminders() and sendManualReminder (application layer) — never reimplemented as a
   second predicate anywhere else.';

revoke all on function app.actionable_requirement_ids(uuid) from public;
grant execute on function app.actionable_requirement_ids(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Rewrite eligible_reminders to use the shared selector instead of its own inline predicate.
-- Same signature/return shape as before (supabase/migrations/20260723153342_reminders_per_
-- participant.sql) — only the "does this participant have anything outstanding" exists() clause
-- changes.
-- ---------------------------------------------------------------------------------------------

create or replace function app.eligible_reminders()
returns table (
  participant_id uuid,
  organization_id uuid,
  case_id uuid,
  grant_id uuid,
  channel text,
  destination text,
  cadence_window integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    c.organization_id,
    c.id,
    g.id,
    'email'::text,
    g.invited_email,
    least(
      o.reminder_max_count - 1,
      floor(
        extract(epoch from (
          now() - (g.verified_at + make_interval(days => o.reminder_first_delay_days))
        )) / (o.reminder_interval_days * 86400.0)
      )::integer
    )
  from public.case_participants p
  join public.cases c
    on c.id = p.case_id and c.organization_id = p.organization_id
  join public.organizations o on o.id = c.organization_id
  join public.case_access_grants g on g.participant_id = p.id
  where c.state = 'open'
    and o.reminder_max_count > 0
    and g.verified_at is not null
    and g.revoked_at is null
    and g.expires_at is not null
    and g.expires_at > now()
    and g.permission <> 'none'
    and now() >= g.verified_at + make_interval(days => o.reminder_first_delay_days)
    and exists (select 1 from app.actionable_requirement_ids(p.id));
$$;

comment on function app.eligible_reminders() is
  'SECURITY-CRITICAL. Pure selection of due (participant, window) reminder tuples. No side effects.
   "Has anything outstanding" now goes through app.actionable_requirement_ids, the same selector
   the manual reminder path uses — see 20260804160400_actionable_requirement_ids.sql.';

revoke all on function app.eligible_reminders() from public;

-- ---------------------------------------------------------------------------------------------
-- Thin public-schema wrapper so application code (which calls RPCs via supabase-js's .rpc(), not
-- direct SQL) can reach the same selector the reminder cron uses internally. security invoker,
-- same reasoning as app.actionable_requirement_ids itself.
-- ---------------------------------------------------------------------------------------------
create or replace function public.list_actionable_requirement_ids(p_participant_id uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  -- The `as id` alias is load-bearing: a setof-scalar function used as a FROM item projects a
  -- single column named after the function itself, not "id", unless the FROM item is aliased.
  select id from app.actionable_requirement_ids(p_participant_id) as id;
$$;

revoke all on function public.list_actionable_requirement_ids(uuid) from public;
grant execute on function public.list_actionable_requirement_ids(uuid) to authenticated;
