// Edge Function: drain the reminder queue.
//
// This is the one place the outside world is touched. pg_cron queues due reminders in SQL; this
// function reads the queued rows as the service role and sends them through Resend.
//
// Deno-native and self-contained by design. It deliberately does NOT import the Next `src/` module
// graph: that code uses `@/` path aliases, extensionless imports, and bare npm specifiers meant
// for the Node build, which the Deno bundler cannot consume. The authoritative, unit-tested
// implementation of this drain is src/features/reminders/send.ts (drainReminderQueue); this mirror
// must stay in step with it. The real safety net for double-sends is the database's unique
// (participant_id, cadence_window) constraint, which holds regardless of which runtime drains.
//
// Two guarantees this shell enforces:
//   * Fail closed. If any required secret is absent it sends NOTHING and returns 503. Deploying it
//     without secrets leaves it inert, not dangerous.
//   * Not publicly invocable. It requires an internal shared secret (REMINDER_TRIGGER_SECRET) in
//     the x-trigger-secret header, on top of the platform's JWT check. An ordinary client — even
//     with a valid anon JWT — cannot trigger a drain.
declare const Deno: { env: { get(key: string): string | undefined } };

import { createClient } from 'jsr:@supabase/supabase-js@2';

const REQUIRED_SECRETS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'REMINDER_FROM_ADDRESS',
  'APP_ORIGIN',
  'REMINDER_TRIGGER_SECRET',
] as const;

const MAX_SEND_ATTEMPTS = 3;
const ALLOWED_CHANNEL = 'email';

/** Length-independent constant-time comparison, so the secret does not leak via timing. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function sendViaResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!response.ok) throw new Error(`Resend responded ${response.status}`);
}

Deno.serve(async (request: Request) => {
  const missing = REQUIRED_SECRETS.filter((name) => !Deno.env.get(name));
  if (missing.length > 0) {
    return Response.json({ error: 'not configured', missing_count: missing.length }, { status: 503 });
  }

  const triggerSecret = Deno.env.get('REMINDER_TRIGGER_SECRET')!;
  const presented = request.headers.get('x-trigger-secret') ?? '';
  if (!secretsMatch(presented, triggerSecret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const resendKey = Deno.env.get('RESEND_API_KEY')!;
  const from = Deno.env.get('REMINDER_FROM_ADDRESS')!;
  const appOrigin = Deno.env.get('APP_ORIGIN')!;

  const { data: deliveries, error } = await admin
    .from('reminder_deliveries')
    .select('id, organization_id, case_id, grant_id, participant_id, channel, destination, attempt_count')
    .in('status', ['queued', 'failed'])
    .lt('attempt_count', MAX_SEND_ATTEMPTS);

  if (error) return Response.json({ error: `read queue: ${error.message}` }, { status: 500 });

  let sent = 0;
  let failed = 0;

  for (const d of deliveries ?? []) {
    const attempt = d.attempt_count + 1;
    try {
      if (d.channel !== ALLOWED_CHANNEL) throw new Error(`unsupported channel: ${d.channel}`);
      if (!d.destination) throw new Error('no destination');

      const { data: caseRow } = await admin
        .from('cases')
        .select('title, organization:organizations(name)')
        .eq('id', d.case_id)
        .single();

      let outstandingQuery = admin
        .from('requirements')
        .select('id', { count: 'exact', head: true })
        .eq('case_id', d.case_id)
        .is('deleted_at', null)
        .is('superseded_at', null)
        .eq('status', 'outstanding');
      if (d.participant_id) outstandingQuery = outstandingQuery.eq('participant_id', d.participant_id);
      const { count: outstanding } = await outstandingQuery;

      // The Portal link is a fresh credential, not the original invitation's — that plaintext
      // token was never persisted anywhere (only its hash), so there is nothing here to "look up"
      // and resend. emit_participant_invitation (supabase/migrations/
      // 20260731130000_participant_invitation_reissue.sql) is the single shared implementation of
      // "issue a fresh Portal link for this participant" — the same one the staff "Recordar"
      // button in the Next.js app calls, so both paths stay identical instead of drifting apart.
      if (!d.participant_id) throw new Error('reminder delivery has no participant_id');
      const { data: reissued, error: reissueError } = await admin
        .rpc('emit_participant_invitation', { p_participant_id: d.participant_id })
        .single();
      if (reissueError || !reissued) {
        throw new Error(`could not reissue invitation: ${reissueError?.message ?? 'no row returned'}`);
      }

      const orgName = (caseRow?.organization as { name?: string } | null)?.name ?? '';
      const count = outstanding ?? 1;
      const noun = count === 1 ? 'item' : 'items';
      const html = [
        `<p>${orgName} is waiting on ${count} ${noun} for your case, ${caseRow?.title ?? ''}.</p>`,
        `<p><a href="${appOrigin}/portal/${reissued.token}">Continue your case</a></p>`,
      ].join('\n');

      await sendViaResend(resendKey, from, d.destination, `Action needed: ${caseRow?.title ?? ''}`, html);

      await admin
        .from('reminder_deliveries')
        .update({ status: 'sent', sent_at: new Date().toISOString(), attempt_count: attempt })
        .eq('id', d.id);
      sent += 1;
    } catch (cause) {
      await admin
        .from('reminder_deliveries')
        .update({
          status: 'failed',
          failed_at: new Date().toISOString(),
          attempt_count: attempt,
          last_error: cause instanceof Error ? cause.message.slice(0, 500) : 'unknown error',
        })
        .eq('id', d.id);
      failed += 1;
    }
  }

  return Response.json({ sent, failed });
});
