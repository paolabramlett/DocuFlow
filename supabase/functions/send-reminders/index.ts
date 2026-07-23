// Edge Function: drain the reminder queue.
//
// This is the one place the outside world is touched. pg_cron queues due reminders in SQL; this
// function reads the queued rows as the service role and sends them through Resend. The Resend
// key is a function secret, never in the database and never in the Next app.
//
// The delivery logic lives in src/features/reminders/send.ts and is unit-tested against a fake
// sender. This file is the thin deployment shell: construct the real clients from secrets, call
// drainReminderQueue, return a count. Keeping the logic out of here is what makes it testable.
//
// Invoked on a schedule by pg_cron (see the cron migration), or manually for a one-off drain.
// Deno global is provided by the Supabase Edge Runtime.
declare const Deno: { env: { get(key: string): string | undefined } };

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  createResendSender,
  drainReminderQueue,
} from '../../../src/features/reminders/send.ts';

function requireSecret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
}

Deno.serve(async () => {
  const admin = createClient(
    requireSecret('SUPABASE_URL'),
    requireSecret('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  );

  const sender = createResendSender(
    requireSecret('RESEND_API_KEY'),
    requireSecret('REMINDER_FROM_ADDRESS'),
  );

  const appOrigin = requireSecret('APP_ORIGIN');
  const buildActionUrl = (grantId: string) => `${appOrigin}/invite/${grantId}`;

  try {
    // deno-lint-ignore no-explicit-any
    const result = await drainReminderQueue(admin as any, sender, buildActionUrl);
    return Response.json(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
});
