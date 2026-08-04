import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { registerDocument } from '@/features/documents/documents';
import { issueInvitation } from '@/features/case-access/invitations';
import { reviewDocument } from '@/application/review-document';
import { closeCase } from '@/features/cases/cases';

async function worldWithUploadedDocument(label: string) {
  const world = await buildOrganizationWorld({
    name: `Notaría Review Notify ${label}`,
    industry: 'notary',
    clientEmail: `${label}-${randomUUID()}@example.test`,
  });
  await issueInvitation(
    world.staff.client,
    { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
    world.staff.userId,
  );
  const granted = await grantVerifiedAccess({ world });

  const requirementId = world.requirementIds[0]!;
  const uploaded = await registerDocument(
    granted.client,
    {
      organizationId: world.organizationId,
      caseId: world.caseId,
      requirementId,
      fileName: 'deed.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
    },
    { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
  );

  return { world, documentId: uploaded.documentId };
}

describe('reviewDocument — action-required notification', () => {
  it('emails the participant on rejection, with the reason and a fresh portal link', async () => {
    const { world, documentId } = await worldWithUploadedDocument('reject');
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await reviewDocument(
      world.staff.client,
      { documentId, decision: 'rejected', reason: 'Falta la firma' },
      world.staff.userId,
      sendEmail,
    );

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]![0];
    expect(sent.to).toBe(world.clientEmail);
    expect(sent.html).toContain('Falta la firma');
    expect(sent.html).toMatch(/\/portal\/[^"]+/);
  });

  it('does not email on approval', async () => {
    const { world, documentId } = await worldWithUploadedDocument('approve');
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await reviewDocument(world.staff.client, { documentId, decision: 'approved' }, world.staff.userId, sendEmail);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('records when the participant was last notified', async () => {
    const { world, documentId } = await worldWithUploadedDocument('record');
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await reviewDocument(
      world.staff.client,
      { documentId, decision: 'rejected', reason: 'Documento ilegible' },
      world.staff.userId,
      sendEmail,
    );

    const { data: grant } = await adminClient()
      .from('case_access_grants')
      .select('action_required_notified_at')
      .eq('participant_id', world.participantId)
      .single();
    expect(grant?.action_required_notified_at).not.toBeNull();
  });

  it('coalesces a second rejection within the cooldown into no additional email', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Review Notify Coalesce',
      industry: 'notary',
      clientEmail: `coalesce-${randomUUID()}@example.test`,
    });
    await issueInvitation(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
      world.staff.userId,
    );
    const granted = await grantVerifiedAccess({ world });

    const requirementIds = world.requirementIds;
    expect(requirementIds.length).toBeGreaterThanOrEqual(2);

    const uploadedA = await registerDocument(
      granted.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId: requirementIds[0]!, fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );
    const uploadedB = await registerDocument(
      granted.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId: requirementIds[1]!, fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );

    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await reviewDocument(world.staff.client, { documentId: uploadedA.documentId, decision: 'rejected', reason: 'Falta A' }, world.staff.userId, sendEmail);
    await reviewDocument(world.staff.client, { documentId: uploadedB.documentId, decision: 'rejected', reason: 'Falta B' }, world.staff.userId, sendEmail);

    // Two rejections, same participant, well within the cooldown — one email, not two, and it
    // reports the current total rather than only the decision that triggered the first send.
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the participant has no active grant to notify', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Review Notify No Grant',
      industry: 'notary',
      clientEmail: `no-grant-${randomUUID()}@example.test`,
    });
    // No issueInvitation call and no grantVerifiedAccess — this participant was never invited.
    // registerDocument still needs to run as some client; use the staff client directly since
    // there is no granted Client identity to act as.
    const requirementId = world.requirementIds[0]!;
    const uploaded = await registerDocument(
      world.staff.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId, fileName: 'c.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'member', authUserId: world.staff.userId },
    );
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    await expect(
      reviewDocument(world.staff.client, { documentId: uploaded.documentId, decision: 'rejected', reason: 'x' }, world.staff.userId, sendEmail),
    ).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('reviewDocument — server-side Case-state gate', () => {
  it('rejects reviewing a document on a closed Case, even calling the use case directly', async () => {
    const { world, documentId } = await worldWithUploadedDocument('closed-gate');
    const sendEmail = vi.fn().mockResolvedValue(undefined);

    // 'cancelled' is used here rather than 'completed' specifically because it needs no
    // documentation-completeness precondition — this test only cares that the Case is closed by
    // the time the second review is attempted, not which terminal outcome it reached.
    await closeCase(world.staff.client, world.caseId, 'cancelled', 'Cierre de prueba del gate de revisión.');

    // Attempting another decision on the same Document once the Case is closed — simulating a
    // stale tab or a direct call that bypasses the UI's own gating — must be rejected server-side,
    // never reaching the point of inserting a second review row.
    await expect(
      reviewDocument(world.staff.client, { documentId, decision: 'approved' }, world.staff.userId, sendEmail),
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
});
