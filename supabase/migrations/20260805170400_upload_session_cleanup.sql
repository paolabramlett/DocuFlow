-- supabase/migrations/20260805170400_upload_session_cleanup.sql
--
-- Three independent cleanup steps (design spec section 4): A and B here are pure Postgres and
-- run on their own schedule; C (the actual Storage object deletion) is a separate Edge Function
-- (supabase/functions/cleanup-upload-sessions/index.ts) so a transient HTTP failure there can
-- never block A or B from keeping the session table's own state correct.

create or replace function app.reclaim_stale_finalizing_sessions()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.document_upload_sessions
     set status = case when expires_at <= now() then 'expired' else 'pending' end,
         claimed_at = null
   where status = 'finalizing'
     and claimed_at <= now() - interval '5 minutes';
$$;

comment on function app.reclaim_stale_finalizing_sessions() is
  'Reclaims a finalizing session whose 5-minute lease has gone stale, back to pending (or directly
   to expired if its own expires_at has also passed). Never touches a finalizing row within its
   live lease. Independent of expire_stale_pending_sessions() and the Storage-deletion step.';

revoke all on function app.reclaim_stale_finalizing_sessions() from public;

create or replace function app.expire_stale_pending_sessions()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.document_upload_sessions
     set status = 'expired'
   where status = 'pending'
     and expires_at <= now();
$$;

comment on function app.expire_stale_pending_sessions() is
  'Expires a pending session whose expires_at has passed. Independent of
   reclaim_stale_finalizing_sessions() and the Storage-deletion step — a pending session expires
   on its own schedule regardless of whether any finalizing reclaim happened this pass.';

revoke all on function app.expire_stale_pending_sessions() from public;

do $$
begin
  perform cron.unschedule('avanza-reclaim-stale-upload-sessions')
  where exists (select 1 from cron.job where jobname = 'avanza-reclaim-stale-upload-sessions');
  perform cron.schedule(
    'avanza-reclaim-stale-upload-sessions',
    '*/5 * * * *',
    $job$ select app.reclaim_stale_finalizing_sessions(); $job$
  );

  perform cron.unschedule('avanza-expire-stale-upload-sessions')
  where exists (select 1 from cron.job where jobname = 'avanza-expire-stale-upload-sessions');
  perform cron.schedule(
    'avanza-expire-stale-upload-sessions',
    '*/5 * * * *',
    $job$ select app.expire_stale_pending_sessions(); $job$
  );
end;
$$;
