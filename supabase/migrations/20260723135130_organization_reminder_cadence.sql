-- Reminder cadence, as Organization policy.
--
-- Same treatment as access_retention_days: real columns with sane defaults, range-checked, and
-- not surfaced in the MVP UI. A different cadence is a different row value, never a code change.
-- These are configuration fields; they grant no new access and do not touch the isolation model.

alter table public.organizations
  add column reminder_first_delay_days integer not null default 3
    check (reminder_first_delay_days between 0 and 365),
  add column reminder_interval_days integer not null default 7
    check (reminder_interval_days between 1 and 365),
  add column reminder_max_count integer not null default 4
    check (reminder_max_count between 0 and 50);

comment on column public.organizations.reminder_first_delay_days is
  'Days after grant activation before the first Client reminder. Default 3.';
comment on column public.organizations.reminder_interval_days is
  'Days between subsequent Client reminders. Default 7.';
comment on column public.organizations.reminder_max_count is
  'Maximum reminders sent per Case. 0 disables reminders for the Organization. Default 4.';
