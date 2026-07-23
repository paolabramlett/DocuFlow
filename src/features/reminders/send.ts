import type { AdminClient } from '@/lib/supabase/admin';
import { parseInput } from '@/lib/validation/parse';
import { recordAuditEvent } from '@/features/audit/record';
import { reminderEmailSchema, resendResponseSchema, type ReminderEmail } from './schemas';

/**
 * A reminder is retried a few times before being left for inspection. Beyond this bound a
 * `failed` row stays visible rather than being retried forever or silently dropped.
 */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * The mail transport. Abstracted behind an interface so the send path is testable without hitting
 * Resend, and so the Resend key lives only where the concrete implementation is constructed —
 * the Edge Function — never in code that a test imports.
 */
export interface MailSender {
  send(email: ReminderEmail): Promise<{ id: string }>;
}

/**
 * The live Resend transport.
 *
 * Constructed only inside the Edge Function, from a function secret. The key is never read in the
 * Next app or in tests.
 */
export function createResendSender(apiKey: string, fromAddress: string): MailSender {
  return {
    async send(email: ReminderEmail): Promise<{ id: string }> {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddress,
          to: email.to,
          subject: `Action needed: ${email.caseTitle}`,
          html: renderReminderHtml(email),
        }),
      });

      if (!response.ok) {
        throw new Error(`Resend responded ${response.status}`);
      }

      return parseInput(resendResponseSchema, await response.json());
    },
  };
}

function renderReminderHtml(email: ReminderEmail): string {
  const noun = email.outstandingCount === 1 ? 'item' : 'items';
  return [
    `<p>${email.organizationName} is waiting on ${email.outstandingCount} ${noun} for your case, ${email.caseTitle}.</p>`,
    `<p><a href="${email.actionUrl}">Continue your case</a></p>`,
  ].join('\n');
}

interface QueuedDelivery {
  readonly id: string;
  readonly organization_id: string;
  readonly case_id: string;
  readonly grant_id: string;
  readonly participant_id: string | null;
  readonly channel: string;
  readonly destination: string | null;
  readonly attempt_count: number;
}

export interface DrainResult {
  readonly sent: number;
  readonly failed: number;
}

/**
 * Sends every queued and retryable-failed reminder.
 *
 * Runs as the service role — the queue is operational data that no single tenant principal can
 * see across Organizations, and the selection that produced these rows already applied every
 * suppression rule. This function's only job is delivery.
 *
 * Idempotency is upstream: a row exists before its send is attempted, and the same cadence window
 * is never queued twice. Here, a row moves queued → sent or queued → failed exactly once per
 * attempt, and only `failed` rows under the attempt bound are retried.
 */
export async function drainReminderQueue(
  admin: AdminClient,
  sender: MailSender,
  buildActionUrl: (grantId: string) => string,
): Promise<DrainResult> {
  const { data: deliveries, error } = await admin
    .from('reminder_deliveries')
    .select(
      'id, organization_id, case_id, grant_id, participant_id, channel, destination, attempt_count, status',
    )
    .in('status', ['queued', 'failed'])
    .lt('attempt_count', MAX_SEND_ATTEMPTS);

  if (error) throw new Error(`Could not read reminder queue: ${error.message}`);

  let sent = 0;
  let failed = 0;

  for (const delivery of (deliveries ?? []) as (QueuedDelivery & { status: string })[]) {
    const outcome = await deliverOne(admin, sender, delivery, buildActionUrl);
    if (outcome === 'sent') sent += 1;
    else failed += 1;
  }

  return { sent, failed };
}

async function deliverOne(
  admin: AdminClient,
  sender: MailSender,
  delivery: QueuedDelivery,
  buildActionUrl: (grantId: string) => string,
): Promise<'sent' | 'failed'> {
  const attempt = delivery.attempt_count + 1;

  try {
    if (delivery.channel !== 'email') {
      throw new Error(`unsupported delivery channel: ${delivery.channel}`);
    }
    if (!delivery.destination) {
      throw new Error('delivery has no destination');
    }

    // The Case context for the email, read now rather than trusted from the queue row.
    const { data: caseRow, error: caseError } = await admin
      .from('cases')
      .select('title, organization:organizations(name)')
      .eq('id', delivery.case_id)
      .single();

    if (caseError || !caseRow) {
      throw new Error(`could not read case: ${caseError?.message ?? 'not found'}`);
    }

    // Count only what this Participant still owes — a reminder chases one party's outstanding
    // work, not the whole Case (design.md D11).
    const outstandingQuery = admin
      .from('requirements')
      .select('id', { count: 'exact', head: true })
      .eq('case_id', delivery.case_id)
      .is('deleted_at', null)
      .is('superseded_at', null)
      .eq('status', 'outstanding');
    const { count: outstanding, error: countError } = delivery.participant_id
      ? await outstandingQuery.eq('participant_id', delivery.participant_id)
      : await outstandingQuery;

    if (countError) throw new Error(`could not count requirements: ${countError.message}`);

    const email = parseInput(reminderEmailSchema, {
      to: delivery.destination,
      organizationName: caseRow.organization?.name ?? '',
      caseTitle: caseRow.title,
      outstandingCount: outstanding ?? 1,
      actionUrl: buildActionUrl(delivery.grant_id),
    });

    await sender.send(email);

    await admin
      .from('reminder_deliveries')
      .update({ status: 'sent', sent_at: new Date().toISOString(), attempt_count: attempt })
      .eq('id', delivery.id);

    await recordAuditEvent(admin, {
      organizationId: delivery.organization_id,
      caseId: delivery.case_id,
      action: 'reminder.sent',
      targetType: 'reminder_delivery',
      targetId: delivery.id,
      actor: { kind: 'system' },
    });

    return 'sent';
  } catch (cause) {
    // The error message is stored for operators, but no email body or URL ever is.
    await admin
      .from('reminder_deliveries')
      .update({
        status: 'failed',
        failed_at: new Date().toISOString(),
        attempt_count: attempt,
        last_error: cause instanceof Error ? cause.message.slice(0, 500) : 'unknown error',
      })
      .eq('id', delivery.id);

    await recordAuditEvent(admin, {
      organizationId: delivery.organization_id,
      caseId: delivery.case_id,
      action: 'reminder.failed',
      targetType: 'reminder_delivery',
      targetId: delivery.id,
      actor: { kind: 'system' },
      metadata: { attempt },
    });

    return 'failed';
  }
}
