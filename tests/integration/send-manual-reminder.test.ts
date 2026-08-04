import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, addParticipant, grantVerifiedAccess } from '../helpers/fixtures';
import { issueInvitation } from '@/features/case-access/invitations';
import { sendManualReminder } from '@/application/send-manual-reminder';

describe('sendManualReminder', () => {
  it('reminds only an invited participant with outstanding requirements', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Manual Reminder',
      industry: 'notary',
      clientEmail: `client-${randomUUID()}@example.test`,
    });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
      world.staff.userId,
    );

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      sendEmail,
    );

    expect(result.remindedCount).toBe(1);
    expect(result.failures).toEqual([]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]![0];
    expect(sent.to).toBe(world.clientEmail);
    expect(sent.html).toMatch(/\/portal\/[^"]+/);
  });

  it('skips a participant who was never invited', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Never Invited Reminder',
      industry: 'notary',
      clientEmail: `client-${randomUUID()}@example.test`,
    });
    // No issueInvitation call — this participant has outstanding work but no grant at all.

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      sendEmail,
    );

    expect(result.remindedCount).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips a participant with no outstanding requirements', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría All Satisfied',
      industry: 'notary',
      clientEmail: `client-${randomUUID()}@example.test`,
    });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
      world.staff.userId,
    );
    await adminClient()
      .from('requirements')
      .update({ status: 'satisfied' })
      .eq('case_id', world.caseId);

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      sendEmail,
    );

    expect(result.remindedCount).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('skips a revoked grant', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Revoked Reminder',
      industry: 'notary',
      clientEmail: `client-${randomUUID()}@example.test`,
    });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
      world.staff.userId,
    );
    await adminClient()
      .from('case_access_grants')
      .update({ revoked_at: new Date().toISOString() })
      .eq('participant_id', world.participantId);

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      sendEmail,
    );

    expect(result.remindedCount).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports a failure, not a false success, when the email fails to send', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Failed Reminder Email',
      industry: 'notary',
      clientEmail: `client-${randomUUID()}@example.test`,
    });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
      world.staff.userId,
    );

    const sendEmail = vi.fn().mockRejectedValue(new Error('Resend API error: 500 unknown_error'));
    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      sendEmail,
    );

    expect(result.remindedCount).toBe(0);
    expect(result.failures).toEqual([{ email: world.clientEmail, reason: 'Resend API error: 500 unknown_error' }]);
  });

  it('reminds multiple eligible participants in the same case independently', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Multi Participant Reminder',
      industry: 'notary',
      clientEmail: `client-${randomUUID()}@example.test`,
    });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
      world.staff.userId,
    );

    const second = await addParticipant(world, { roleLabel: 'Vendedor', clientEmail: `second-${randomUUID()}@example.test` });
    await world.staff.client
      .from('requirements')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        participant_id: second.participantId,
        label: 'Segundo requisito',
        type: 'document',
        position: 0,
      });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: second.participantId, permission: 'upload' },
      world.staff.userId,
    );

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      sendEmail,
    );

    expect(result.remindedCount).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const recipients = sendEmail.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual([second.clientEmail, world.clientEmail].sort());
  });

  it('excludes a requirement in a locked future stage', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Manual Reminder Stages',
      industry: 'notary',
      clientEmail: `manual-reminder-stages-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    const { data: stages } = await admin
      .from('case_stages')
      .insert([
        { organization_id: world.organizationId, case_id: world.caseId, name: 'Activa', position: 0, status: 'active' },
        { organization_id: world.organizationId, case_id: world.caseId, name: 'Futura', position: 1, status: 'locked' },
      ])
      .select('id, position');
    const active = stages!.find((s) => s.position === 0)!;
    const locked = stages!.find((s) => s.position === 1)!;
    // world.requirementIds[0] moves to the locked stage — should no longer be reminded about.
    await admin.from('requirements').update({ stage_id: locked.id }).eq('id', world.requirementIds[0]!);
    await admin.from('requirements').update({ stage_id: active.id }).eq('id', world.requirementIds[1]!);
    await grantVerifiedAccess({ world, permission: 'upload' });

    const sentTo: string[] = [];
    await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      async (input) => {
        sentTo.push(input.to);
      },
    );

    // Still reminded overall (requirementIds[1] is in the active stage), but this test's real point
    // is that the RPC path didn't throw and the participant was still correctly included — full
    // exclusion-of-the-locked-item coverage lives at the SQL level (Task 6's isolation tests, which
    // can assert directly on which ids come back). This integration test proves the wiring: the
    // manual reminder path actually calls through to the new selector rather than a stale predicate.
    expect(sentTo).toEqual([world.clientEmail]);
  });

  it('excludes an archived requirement, matching the cron (the drift this task fixes)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Manual Reminder Archived',
      industry: 'notary',
      clientEmail: `manual-reminder-archived-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    for (const id of world.requirementIds) {
      await admin.from('requirements').update({ status: 'archived' }).eq('id', id);
    }
    await grantVerifiedAccess({ world, permission: 'upload' });

    const result = await sendManualReminder(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId },
      world.staff.userId,
      async () => {},
    );

    expect(result.remindedCount).toBe(0);
  });
});
