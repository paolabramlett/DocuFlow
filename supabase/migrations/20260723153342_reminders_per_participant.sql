-- Reminders become per-Participant and channel-agnostic, and selection is split from queuing
-- (design.md D5, D6).

-- ---------------------------------------------------------------------------------------------
-- reminder_deliveries: per-participant, channel-agnostic
-- ---------------------------------------------------------------------------------------------

alter table public.reminder_deliveries
  add column participant_id uuid,
  -- Channel-agnostic delivery: email is the only channel now, but the record does not bake it in
  -- (design.md D5). Provider specifics live in the delivery adapter, never here.
  add column channel text not null default 'email' check (channel in ('email')),
  add column destination text;

-- Backfill is unnecessary (fresh reset, empty table). Move the recipient from the email-specific
-- column to the generic one, then drop the old column.
update public.reminder_deliveries set destination = sent_to_email;
alter table public.reminder_deliveries drop column sent_to_email;

-- The idempotency key moves from the Case to the Participant: each party of a Case is chased on
-- its own stream, and none double-sends.
alter table public.reminder_deliveries
  drop constraint reminder_deliveries_case_id_cadence_window_key;
alter table public.reminder_deliveries
  add constraint reminder_deliveries_participant_cadence_window_key
  unique (participant_id, cadence_window);

alter table public.reminder_deliveries
  add constraint reminder_deliveries_participant_fk
  foreign key (participant_id, organization_id)
  references public.case_participants (id, organization_id) on delete cascade;

-- ---------------------------------------------------------------------------------------------
-- Selection split: eligible_reminders (pure) + queue_reminders (insert) (design.md D6)
-- ---------------------------------------------------------------------------------------------

drop function if exists app.select_due_reminders();

-- Pure, side-effect-free selection. One question: which (participant, window) tuples are due?
-- Directly testable without writing anything. SECURITY-CRITICAL, same rules as the resolvers.
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
    -- active grant, matching app.granted_participant_ids
    and g.verified_at is not null
    and g.revoked_at is null
    and g.expires_at is not null
    and g.expires_at > now()
    and g.permission <> 'none'
    and now() >= g.verified_at + make_interval(days => o.reminder_first_delay_days)
    -- at least one outstanding requirement assigned to THIS participant; unassigned Staff
    -- requirements never chase a client (design.md D11)
    and exists (
      select 1 from public.requirements r
      where r.participant_id = p.id
        and r.deleted_at is null
        and r.superseded_at is null
        and r.status = 'outstanding'
    );
$$;

comment on function app.eligible_reminders() is
  'SECURITY-CRITICAL. Pure selection of due (participant, window) reminder tuples. No side effects.';

revoke all on function app.eligible_reminders() from public;

-- The side-effecting half: queue what eligible_reminders returns, idempotently. This is what the
-- cron runs. Provider-unaware — it names no channel logic beyond copying the channel through.
create or replace function app.queue_reminders()
returns table (
  delivery_id uuid,
  participant_id uuid,
  organization_id uuid,
  case_id uuid,
  grant_id uuid,
  channel text,
  destination text,
  cadence_window integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with queued as (
    insert into public.reminder_deliveries
      (organization_id, case_id, grant_id, participant_id, cadence_window, channel, destination, status)
    select
      e.organization_id, e.case_id, e.grant_id, e.participant_id, e.cadence_window,
      e.channel, e.destination, 'queued'
    from app.eligible_reminders() e
    where e.cadence_window >= 0
    on conflict (participant_id, cadence_window) do nothing
    returning id, reminder_deliveries.participant_id, reminder_deliveries.organization_id,
              reminder_deliveries.case_id, reminder_deliveries.grant_id,
              reminder_deliveries.channel, reminder_deliveries.destination,
              reminder_deliveries.cadence_window
  )
  select q.id, q.participant_id, q.organization_id, q.case_id, q.grant_id,
         q.channel, q.destination, q.cadence_window
  from queued q;
end;
$$;

comment on function app.queue_reminders() is
  'SECURITY-CRITICAL. Queues eligible reminders idempotently per (participant, cadence_window).';

revoke all on function app.queue_reminders() from public;

-- ---------------------------------------------------------------------------------------------
-- Reschedule the cron to call the new entry point
-- ---------------------------------------------------------------------------------------------

do $$
begin
  perform cron.unschedule('docuflow-queue-reminders')
  where exists (select 1 from cron.job where jobname = 'docuflow-queue-reminders');

  perform cron.schedule(
    'docuflow-queue-reminders',
    '*/15 * * * *',
    $job$ select app.queue_reminders(); $job$
  );
end;
$$;
