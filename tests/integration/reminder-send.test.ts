import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { queueDueReminders } from '../helpers/db';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type OrganizationWorld,
} from '../helpers/fixtures';
import { drainReminderQueue, MAX_SEND_ATTEMPTS, type MailSender } from '@/features/reminders/send';
import type { ReminderEmail } from '@/features/reminders/schemas';

const DAY_MS = 24 * 60 * 60 * 1000;

async function dueWorld(label: string): Promise<OrganizationWorld> {
  const world = await buildOrganizationWorld({
    name: `Notaría ${label}`,
    industry: 'notary',
    clientEmail: `${label.toLowerCase()}-${randomUUID()}@example.test`,
  });
  await grantVerifiedAccess({ world, verifiedAt: new Date(Date.now() - 4 * DAY_MS) });
  return world;
}

/** A sender that records what it was asked to send, and can be told to fail. */
function recordingSender(): MailSender & { readonly sent: ReminderEmail[] } {
  const sent: ReminderEmail[] = [];
  return {
    sent,
    async send(email: ReminderEmail) {
      sent.push(email);
      return { id: `test-${sent.length}` };
    },
  };
}

function failingSender(): MailSender {
  return {
    async send() {
      throw new Error('resend unavailable');
    },
  };
}

const actionUrl = (grantId: string) => `https://app.docuflow.test/invite/${grantId}`;

describe('reminder send path', () => {
  it('sends a queued reminder to the grant address and marks it sent', async () => {
    const world = await dueWorld('Send');
    await queueDueReminders();
    const sender = recordingSender();

    const result = await drainReminderQueue(adminClient(), sender, actionUrl);

    const mine = sender.sent.filter((email) => email.to === world.clientEmail);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.caseTitle).toBe('Property transfer');
    expect(mine[0]?.outstandingCount).toBe(3);
    expect(result.sent).toBeGreaterThanOrEqual(1);

    const { data } = await adminClient()
      .from('reminder_deliveries')
      .select('status, sent_at, attempt_count')
      .eq('case_id', world.caseId)
      .single();
    expect(data?.status).toBe('sent');
    expect(data?.sent_at).not.toBeNull();
    expect(data?.attempt_count).toBe(1);
  });

  it('records a send as an audit event carrying no body or url', async () => {
    const world = await dueWorld('Audit');
    await queueDueReminders();
    await drainReminderQueue(adminClient(), recordingSender(), actionUrl);

    const { data } = await world.staff.client
      .from('audit_events')
      .select('action, metadata')
      .eq('case_id', world.caseId)
      .eq('action', 'reminder.sent');

    expect(data).toHaveLength(1);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('docuflow.test');
    expect(serialized).not.toContain('waiting on');
  });

  it('does not resend an already-sent delivery on a second drain', async () => {
    const world = await dueWorld('NoResend');
    await queueDueReminders();

    const first = recordingSender();
    await drainReminderQueue(adminClient(), first, actionUrl);
    const firstCount = first.sent.filter((e) => e.to === world.clientEmail).length;
    expect(firstCount).toBe(1);

    const second = recordingSender();
    await drainReminderQueue(adminClient(), second, actionUrl);
    expect(second.sent.filter((e) => e.to === world.clientEmail)).toHaveLength(0);
  });

  it('marks a failed send failed, and retries it up to the bound', async () => {
    const world = await dueWorld('Retry');
    await queueDueReminders();

    // Fail every attempt.
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      await drainReminderQueue(adminClient(), failingSender(), actionUrl);
    }

    const afterExhaustion = await adminClient()
      .from('reminder_deliveries')
      .select('status, attempt_count, last_error')
      .eq('case_id', world.caseId)
      .single();

    expect(afterExhaustion.data?.status).toBe('failed');
    expect(afterExhaustion.data?.attempt_count).toBe(MAX_SEND_ATTEMPTS);
    expect(afterExhaustion.data?.last_error).toContain('resend unavailable');

    // One more drain must not retry an exhausted row.
    const beyond = recordingSender();
    await drainReminderQueue(adminClient(), beyond, actionUrl);
    expect(beyond.sent.filter((e) => e.to === world.clientEmail)).toHaveLength(0);
  });

  it('recovers: a failed delivery sends on a later successful drain', async () => {
    const world = await dueWorld('Recover');
    await queueDueReminders();

    await drainReminderQueue(adminClient(), failingSender(), actionUrl);
    const failed = await adminClient()
      .from('reminder_deliveries')
      .select('status')
      .eq('case_id', world.caseId)
      .single();
    expect(failed.data?.status).toBe('failed');

    const sender = recordingSender();
    await drainReminderQueue(adminClient(), sender, actionUrl);

    expect(sender.sent.filter((e) => e.to === world.clientEmail)).toHaveLength(1);
    const recovered = await adminClient()
      .from('reminder_deliveries')
      .select('status')
      .eq('case_id', world.caseId)
      .single();
    expect(recovered.data?.status).toBe('sent');
  });
});
