import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStagedOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { advanceCaseStage } from '@/features/cases/cases';

/**
 * advanceCaseStage (src/features/cases/cases.ts) is supposed to notify every Participant the
 * advance_case_stage RPC identifies as having a newly actionable requirement in the freshly
 * activated Stage (design spec §6, fix #5) — a gap Task 7 left untested because its own tests
 * mocked advanceCaseStage itself at the Server Action layer. These tests drive the real RPC
 * against a local Postgres instance and assert on the module-level sendTransactionalEmail import,
 * exactly like tests/integration/case-closure-use-case.test.ts does for closeCase/reopenCase.
 */
describe('advanceCaseStage notifies Participants of new work', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a stage-advance email to a Participant with a newly actionable requirement', async () => {
    const world = await buildStagedOrganizationWorld({
      name: 'Notaría UseCase Advance',
      industry: 'notary',
      clientEmail: `usecase-advance-${randomUUID()}@example.test`,
      stageCount: 2,
    });
    await grantVerifiedAccess({ world, permission: 'upload' });
    // Stage 0 gets requirements 0 and 2 (round-robin over 3), stage 1 gets requirement 1 — satisfy
    // everything assigned to the active (first) stage so the RPC is willing to advance.
    const stageZeroRequirementIds = [world.requirementIds[0], world.requirementIds[2]].filter(
      (id): id is string => id !== undefined,
    );
    expect(stageZeroRequirementIds).toHaveLength(2);
    await world.staff.client
      .from('requirements')
      .update({ status: 'satisfied' })
      .in('id', stageZeroRequirementIds);

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    const notifiedParticipantIds = await advanceCaseStage(world.staff.client, world.caseId);

    expect(notifiedParticipantIds).toEqual([world.participantId]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const call = sendEmail.mock.calls[0]?.[0];
    expect(call?.to).toBe(world.clientEmail);
    expect(call?.subject).toContain('Nuevos documentos requeridos');
    expect(call?.html).toContain('avanzó de etapa');
  });

  it('sends no email when the RPC returns no newly actionable Participant (e.g. last stage)', async () => {
    const world = await buildStagedOrganizationWorld({
      name: 'Notaría UseCase Advance Last',
      industry: 'notary',
      clientEmail: `usecase-advance-last-${randomUUID()}@example.test`,
      stageCount: 1,
    });
    // Single stage: every requirement lands on it. Satisfy them all so the RPC completes the last
    // (and only) stage with no next stage to activate — an empty notified-participant result.
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('case_id', world.caseId);

    const sendEmail = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockImplementation(sendEmail);

    const notifiedParticipantIds = await advanceCaseStage(world.staff.client, world.caseId);

    expect(notifiedParticipantIds).toEqual([]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a notification failure does not throw past advanceCaseStage (best-effort)', async () => {
    const world = await buildStagedOrganizationWorld({
      name: 'Notaría UseCase Advance Fail',
      industry: 'notary',
      clientEmail: `usecase-advance-fail-${randomUUID()}@example.test`,
      stageCount: 2,
    });
    await grantVerifiedAccess({ world, permission: 'upload' });
    const stageZeroRequirementIds = [world.requirementIds[0], world.requirementIds[2]].filter(
      (id): id is string => id !== undefined,
    );
    await world.staff.client
      .from('requirements')
      .update({ status: 'satisfied' })
      .in('id', stageZeroRequirementIds);
    vi.spyOn(await import('@/lib/email/resend'), 'sendTransactionalEmail').mockRejectedValue(new Error('boom'));

    await expect(advanceCaseStage(world.staff.client, world.caseId)).resolves.toEqual([world.participantId]);
  });
});
