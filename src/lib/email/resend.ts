import { RESEND_API_KEY } from '@/lib/supabase/env';

export interface SendTransactionalEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly idempotencyKey?: string;
}

/**
 * Sends one transactional email directly via Resend's HTTP API — not through Supabase Auth's
 * mailer, which only handles Supabase-native auth emails (invite/recovery/magic link). Reserved
 * for product-initiated notifications that have nothing to do with authentication, e.g. "you were
 * added to an existing organization" (see src/application/invite-member.ts).
 */
export async function sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Resend's HTTP API rejects requests with no User-Agent (403, error 1010) — its own SDK
      // sets this automatically; a manual fetch has to do it explicitly. This string is never
      // user-visible.
      'User-Agent': 'avanza/1.0',
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: 'Avanza <noreply@avanza.work>',
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });

  if (!response.ok) {
    // Parsed only for Resend's own error `name`/`message` fields — never the raw response body,
    // which could otherwise carry recipient/content details into logs.
    const body = await response.json().catch(() => null);
    throw new Error(`Resend API error: ${response.status} ${body?.name ?? body?.message ?? 'unknown_error'}`);
  }
}
