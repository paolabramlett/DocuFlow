-- app.select_due_reminders(): queues a reminder for every Case that is due for one, and returns
-- what it queued so the sender can act.
--
-- SECURITY-CRITICAL, and SECURITY DEFINER for a specific reason: it must serve every tenant's
-- cron in one pass, so it reads across Organizations. Same rules as the authorization resolvers —
-- no dynamic SQL, pinned search_path, one narrow job. It never returns tenant data to a caller;
-- it writes queued rows and returns their identifiers plus the send address.
--
-- Cadence math. For a grant activated at A with policy (first_delay D, interval I, max M):
--   reminder k is due at  A + D days + k*I days,  for k in 0 .. M-1.
-- The "current window" is the highest k whose due time has passed, capped at M-1:
--   k = floor( (now - (A + D)) / I ),  clamped to [0, M-1].
-- Only the current window is queued, never the windows a lapsed cron missed — a client should
-- get one nudge now, not a burst of three. The unique (case_id, cadence_window) constraint makes
-- re-queueing the same window a no-op, so overlap and retry are safe.
--
-- "Active grant" here MUST match app.granted_case_ids: verified, not revoked, not expired. It is
-- inlined rather than called because that function keys off the caller's auth.uid(), and this one
-- runs as definer across all callers.

create or replace function app.select_due_reminders()
returns table (
  delivery_id uuid,
  organization_id uuid,
  case_id uuid,
  grant_id uuid,
  sent_to_email text,
  cadence_window integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with due as (
    select
      c.id                as case_id,
      c.organization_id   as organization_id,
      g.id                as grant_id,
      g.invited_email     as invited_email,
      least(
        o.reminder_max_count - 1,
        floor(
          extract(epoch from (
            now() - (g.verified_at + make_interval(days => o.reminder_first_delay_days))
          )) / (o.reminder_interval_days * 86400.0)
        )::integer
      ) as window
    from public.cases c
    join public.organizations o on o.id = c.organization_id
    join public.case_access_grants g
      on g.case_id = c.id and g.organization_id = c.organization_id
    where c.state = 'open'
      and o.reminder_max_count > 0
      -- active grant, matching app.granted_case_ids
      and g.verified_at is not null
      and g.revoked_at is null
      and g.expires_at is not null
      and g.expires_at > now()
      and g.permission <> 'none'
      -- the first-delay has elapsed since activation
      and now() >= g.verified_at + make_interval(days => o.reminder_first_delay_days)
      -- at least one outstanding requirement remains
      and exists (
        select 1 from public.requirements r
        where r.case_id = c.id
          and r.deleted_at is null
          and r.status <> 'satisfied'
      )
  ),
  queued as (
    insert into public.reminder_deliveries
      (organization_id, case_id, grant_id, cadence_window, sent_to_email, status)
    select due.organization_id, due.case_id, due.grant_id, due.window, due.invited_email, 'queued'
    from due
    where due.window >= 0
    on conflict (case_id, cadence_window) do nothing
    returning id, reminder_deliveries.organization_id, reminder_deliveries.case_id,
              reminder_deliveries.grant_id, reminder_deliveries.sent_to_email,
              reminder_deliveries.cadence_window
  )
  select q.id, q.organization_id, q.case_id, q.grant_id, q.sent_to_email, q.cadence_window
  from queued q;
end;
$$;

comment on function app.select_due_reminders() is
  'SECURITY-CRITICAL. Queues one reminder per due Case (idempotent per cadence window) and returns the queued rows.';

-- Not callable by any API role. Only the cron job invokes it, in SQL as the table owner. It is
-- never exposed over PostgREST; the sender drains the queued rows it produces, it does not call
-- selection itself.
revoke all on function app.select_due_reminders() from public;
