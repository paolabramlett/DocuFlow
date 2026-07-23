-- reminder_deliveries: one row per reminder attempted against a Case.
--
-- The row is the idempotency key, not a lock (design.md D2). It is written in `queued` state
-- *before* the email is attempted, guarded by a unique (case_id, cadence_window). Two overlapping
-- cron runs cannot both queue the same window; the second conflicts and does nothing. The failure
-- mode is recorded-but-unsent (visible, retryable), never sent-but-unrecorded.

-- The composite foreign key below needs the parent to expose (id, organization_id) as a key.
-- cases already has one from the initial schema; case_access_grants did not, so add it here.
alter table public.case_access_grants
  add constraint case_access_grants_id_organization_key unique (id, organization_id);

create table public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  grant_id uuid not null,

  -- Deterministic bucket derived from grant activation time, interval, and reminder ordinal —
  -- never from now() (design.md D2). Same inputs always yield the same window, which is what
  -- makes the unique constraint below an idempotency guarantee rather than a coincidence.
  cadence_window integer not null check (cadence_window >= 0),

  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),

  -- The address the reminder was sent to, copied from the grant at queue time so the record is
  -- self-contained and auditable. Never a message body, subject, or URL (client-reminders spec).
  sent_to_email text,

  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  last_error text,

  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade,
  foreign key (grant_id, organization_id)
    references public.case_access_grants (id, organization_id) on delete cascade,

  -- The idempotency guarantee. One reminder per Case per cadence window, enforced by the
  -- database rather than by application timing.
  unique (case_id, cadence_window)
);

create index reminder_deliveries_organization_idx
  on public.reminder_deliveries (organization_id, queued_at desc);

create index reminder_deliveries_case_idx
  on public.reminder_deliveries (case_id, cadence_window);

-- The sender drains queued rows and retries failed ones; this index carries that scan.
create index reminder_deliveries_status_idx
  on public.reminder_deliveries (status)
  where status in ('queued', 'failed');

alter table public.reminder_deliveries enable row level security;

-- Members of the owning Organization read the delivery history. Clients never do: reminders are
-- about the Client but are Staff-side operational data.
create policy reminder_deliveries_select_by_member
  on public.reminder_deliveries
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

-- No client-facing write policy. Queueing and status updates happen through the SECURITY DEFINER
-- selection function and the service-role sender, not through an authenticated principal.
grant select on public.reminder_deliveries to authenticated;
grant all on public.reminder_deliveries to service_role;
