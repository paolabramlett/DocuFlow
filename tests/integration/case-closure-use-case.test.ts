import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addParticipant, buildOrganizationWorld, grantVerifiedAccess, type OrganizationWorld } from '../helpers/fixtures';
import { adminClient } from '../helpers/clients';
import { closeCase, reopenCase } from '@/features/cases/cases';

async function completeAllRequirements(world: OrganizationWorld) {
  for (const id of world.requirementIds) {
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
  }
}

describe('closeCase / reopenCase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes as completed and sends the closure email to the active Participant', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Close',
      industry: 'notary',
      clientEmail: `usecase-close-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await grantVerifiedAccess({ world, permission: 'view' });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    await closeCase(world.staff.client, world.caseId, 'completed', undefined);

    const { data } = await adminClient().from('cases').select('state').eq('id', world.caseId).single();
    expect(data?.state).toBe('completed');
  });

  it('a notification failure does not throw past closeCase (best-effort)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Close Fail',
      industry: 'notary',
      clientEmail: `usecase-close-fail-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await grantVerifiedAccess({ world, permission: 'view' });
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockRejectedValue(new Error('boom'));

    await expect(closeCase(world.staff.client, world.caseId, 'completed', undefined)).resolves.toBeUndefined();
    const { data } = await adminClient().from('cases').select('state').eq('id', world.caseId).single();
    expect(data?.state).toBe('completed'); // the RPC still succeeded
  });

  it('rejects completion with documentation_incomplete mapped to a validation UseCaseError', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Incomplete',
      industry: 'notary',
      clientEmail: `usecase-incomplete-${randomUUID()}@example.test`,
    });

    await expect(closeCase(world.staff.client, world.caseId, 'completed', undefined)).rejects.toMatchObject({
      reason: 'validation',
    });
  });

  it('reopening with zero restorable grants sends no email and reports requiresReinvitation', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Reopen NoGrants',
      industry: 'notary',
      clientEmail: `usecase-reopen-none-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    const result = await reopenCase(world.staff.client, world.caseId);

    expect(result).toEqual({ restoredParticipantIds: [], requiresReinvitation: true, notificationFailureCount: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reopening calls emit_participant_invitation exactly once per restored Participant', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Reopen Invite',
      industry: 'notary',
      clientEmail: `usecase-reopen-invite-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await grantVerifiedAccess({ world, permission: 'upload' });
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockResolvedValue(undefined);
    const rpcSpy = vi.spyOn(world.staff.client, 'rpc');

    const result = await reopenCase(world.staff.client, world.caseId);

    expect(result.restoredParticipantIds).toEqual([world.participantId]);
    const reissueCalls = rpcSpy.mock.calls.filter(([name]) => name === 'emit_participant_invitation');
    expect(reissueCalls).toHaveLength(1);
  });

  it('one restored Participant failing to notify does not strand the others', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría UseCase Reopen PartialFail',
      industry: 'notary',
      clientEmail: `usecase-reopen-partial-a-${randomUUID()}@example.test`,
    });
    const second = await addParticipant(world, {
      roleLabel: 'Segundo',
      clientEmail: `usecase-reopen-partial-b-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    const firstGrant = await grantVerifiedAccess({ world, permission: 'upload' });
    const secondGrant = await grantVerifiedAccess({
      world,
      participantId: second.participantId,
      clientId: second.clientId,
      existingEmail: second.clientEmail,
      permission: 'upload',
    });
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);

    // Fails for whichever Participant is notified first, succeeds for the second — proving the
    // loop reaches every restored Participant instead of stopping at the first failure.
    const sendEmail = vi.fn().mockRejectedValueOnce(new Error('delivery failed')).mockResolvedValueOnce(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    const result = await reopenCase(world.staff.client, world.caseId);

    expect(result.restoredParticipantIds.sort()).toEqual([world.participantId, second.participantId].sort());
    expect(result.notificationFailureCount).toBe(1);
    // Both Participants were actually attempted — the failure on the first call didn't stop the
    // loop from reaching the second.
    expect(sendEmail).toHaveBeenCalledTimes(2);

    // Restoration itself (permission/expiry) never depends on whether the email succeeded — both
    // grants come back to 'upload' regardless of which one failed to notify.
    const { data: grants } = await adminClient()
      .from('case_access_grants')
      .select('id, permission')
      .in('id', [firstGrant.grantId, secondGrant.grantId]);
    expect(grants?.every((g) => g.permission === 'upload')).toBe(true);
  });
});
