// Edge Function: delete the Storage objects for expired/cancelled upload sessions.
//
// This is the one place the outside world (Storage's own HTTP API) is touched for cleanup. The
// two purely-internal reclaim/expire steps (app.reclaim_stale_finalizing_sessions(),
// app.expire_stale_pending_sessions()) already ran via pg_cron and moved the relevant rows to
// 'expired'/'cancelled' before this function ever runs — this function's only job is deleting the
// underlying Storage object for a row already in one of those terminal states, on its own
// schedule. A transient failure here leaves an orphan for the NEXT run to retry; it never blocks
// or is blocked by the two SQL steps (design spec section 4, step C).
declare const Deno: { env: { get(key: string): string | undefined } };

import { createClient } from 'jsr:@supabase/supabase-js@2';

const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'UPLOAD_CLEANUP_TRIGGER_SECRET',
] as const;

const BATCH_SIZE = 200;

function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (request: Request) => {
  const missing = REQUIRED_SECRETS.filter((name) => !Deno.env.get(name));
  if (missing.length > 0) {
    return Response.json({ error: 'not configured', missing_count: missing.length }, { status: 503 });
  }

  const triggerSecret = Deno.env.get('UPLOAD_CLEANUP_TRIGGER_SECRET')!;
  const presented = request.headers.get('x-trigger-secret') ?? '';
  if (!secretsMatch(presented, triggerSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // Rows in a terminal state whose Storage object hasn't been confirmed removed. There's no
  // separate "storage_deleted_at" column in this MVP — a session in ('expired','cancelled') is
  // simply attempted every run; a successful storage.remove() on an already-absent object is not
  // an error (Supabase Storage's remove() is idempotent for a missing key), so re-attempting a
  // row already cleaned up in a prior run is harmless, not a bug.
  const { data: sessions, error } = await admin
    .from('document_upload_sessions')
    .select('id, bucket, storage_path')
    .in('status', ['expired', 'cancelled'])
    .limit(BATCH_SIZE);

  if (error) return Response.json({ error: `read sessions: ${error.message}` }, { status: 500 });

  let deleted = 0;
  let failed = 0;

  for (const s of sessions ?? []) {
    try {
      const { error: removeError } = await admin.storage.from(s.bucket).remove([s.storage_path]);
      if (removeError) throw new Error(removeError.message);
      deleted += 1;
    } catch (cause) {
      failed += 1;
      console.error('Failed to delete an orphaned upload session object', { sessionId: s.id, cause });
    }
  }

  return Response.json({ deleted, failed, total: sessions?.length ?? 0 });
});
