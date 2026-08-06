-- supabase/migrations/20260805170500_upload_session_retention.sql
--
-- Closes the gap in the final whole-branch review (Important #5): design spec section 3 promises
-- "a second, separate cleanup pass [that] purges rows in a terminal state older than the retention
-- window" — that pass did not exist anywhere. Combined with the Edge Function's original
-- unbounded, unordered `.in('status', ['expired','cancelled']).limit(200)` scan (no
-- "already handled" marker, no ORDER BY), the candidate set could only ever grow: once more than
-- 200 lifetime cancelled/expired sessions accumulated in an environment, PostgREST would keep
-- returning the same already-cleaned 200 rows forever, and newly-cancelled sessions past the
-- 200th would never be reached — the Storage-deletion step silently starves.
--
-- This migration:
--   1. adds `storage_deleted_at`, so the Edge Function can mark a row done and stop re-scanning it;
--   2. adds `app.purge_expired_upload_sessions()`, the missing retention-purge pass, hard-deleting
--      terminal rows whose Storage object is confirmed gone and old enough (30 days — the upper
--      end of design spec section 3's stated 7-30 day range; no more specific value is established
--      anywhere else in this plan);
--   3. schedules it via the same cron.schedule idiom as the other two cleanup functions, but daily
--      rather than every 5 minutes — a retention purge has no latency requirement, unlike reclaim/
--      expire, which exist specifically to unblock a Participant's next attempt quickly.
--
-- The Edge Function itself (supabase/functions/cleanup-upload-sessions/index.ts) is updated in the
-- same change to set this column after a successful remove() and to filter/order its own query on
-- it — see that file's own comments for the query-shape half of this fix.

alter table public.document_upload_sessions
  add column storage_deleted_at timestamptz;

comment on column public.document_upload_sessions.storage_deleted_at is
  'Set by the cleanup-upload-sessions Edge Function after a confirmed-successful storage.remove()
   for a session in a terminal state (expired/cancelled only — never set for completed, whose
   Storage object is the real Document and must never be deleted by this pipeline). Null means
   "not yet attempted or not yet confirmed removed". Used both to stop the Edge Function
   re-scanning already-cleaned rows and as the anchor for app.purge_expired_upload_sessions()''s
   retention window.';

-- Index for the Edge Function's own query: WHERE status IN (...) AND storage_deleted_at IS NULL,
-- ORDER BY created_at ASC. Partial on the same two terminal statuses as the existing cleanup index
-- (document_upload_sessions_cleanup_idx), which covers pending/finalizing instead.
create index document_upload_sessions_storage_cleanup_idx
  on public.document_upload_sessions (created_at)
  where status in ('expired', 'cancelled') and storage_deleted_at is null;

create or replace function app.purge_expired_upload_sessions()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.document_upload_sessions
   where status in ('expired', 'cancelled')
     and storage_deleted_at is not null
     and storage_deleted_at <= now() - interval '30 days';
$$;

comment on function app.purge_expired_upload_sessions() is
  'Design spec section 3''s retention purge: hard-deletes expired/cancelled rows whose Storage
   object is confirmed removed (storage_deleted_at set) and the deletion happened at least 30 days
   ago. Never touches a row whose Storage object has not yet been confirmed removed, and never
   touches a completed row (storage_deleted_at is never set for one). Independent of
   reclaim_stale_finalizing_sessions()/expire_stale_pending_sessions() and of the Edge Function
   itself — this is a pure retention pass over rows those two already finished with.';

revoke all on function app.purge_expired_upload_sessions() from public;

do $$
begin
  perform cron.unschedule('avanza-purge-expired-upload-sessions')
  where exists (select 1 from cron.job where jobname = 'avanza-purge-expired-upload-sessions');
  -- Daily, not every 5 minutes like reclaim/expire: this is a pure retention purge with no latency
  -- requirement (nothing waits on it the way a Participant's next finalize attempt waits on
  -- reclaim/expire), so a low-frequency schedule is deliberate, not an oversight.
  perform cron.schedule(
    'avanza-purge-expired-upload-sessions',
    '0 3 * * *',
    $job$ select app.purge_expired_upload_sessions(); $job$
  );
end;
$$;
