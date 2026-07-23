-- The reminder schedule.
--
-- pg_cron runs the SQL selection on a cadence. This job only *queues* due reminders — it holds no
-- access decision and touches no external service. Draining the queue and sending mail is the
-- Edge Function's job, scheduled separately at deploy time, because that step needs the Resend
-- secret and an outbound HTTP call and must not live in a cron command string in the database.

create extension if not exists pg_cron;

-- Every 15 minutes, queue any Case that has become due. Idempotent: a window already queued is a
-- no-op, so overlapping runs are safe. `select_due_reminders` returns rows, so its result is
-- discarded into a PERFORM-style wrapper via a plain select.
do $$
begin
  -- Unschedule a prior definition if this migration is re-run against a live cron catalog.
  perform cron.unschedule('docuflow-queue-reminders')
  where exists (select 1 from cron.job where jobname = 'docuflow-queue-reminders');

  perform cron.schedule(
    'docuflow-queue-reminders',
    '*/15 * * * *',
    $job$ select app.select_due_reminders(); $job$
  );
end;
$$;
