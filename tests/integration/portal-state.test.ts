import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrganizationWorld, grantVerifiedAccess, type GrantedClient, type OrganizationWorld } from '../helpers/fixtures';
import { decideReview, registerDocument } from '@/features/documents/documents';
import { getPortalCase } from '@/features/case-access/portal-queries';

/**
 * Regression coverage for a real bug found while verifying the Client Portal end to end: state
 * was derived from the single most-recent *review* across a Requirement's entire document
 * history, rather than from its latest Document's own review. A rejected Document's review
 * therefore kept outranking a brand-new, not-yet-reviewed re-upload forever — the Client Portal
 * (and the Staff workspace, which shares the same defect) would show "Rechazado" with a stale
 * reason even after the client had already acted on it.
 */
describe('portal read model: latest Document wins, not latest review', () => {
  let world: OrganizationWorld;
  let granted: GrantedClient;
  let requirementId: string;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Portal State',
      industry: 'notary',
      clientEmail: `portal-state-${randomUUID()}@example.test`,
    });
    granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const first = world.requirementIds[0];
    if (!first) throw new Error('fixture requirement missing');
    requirementId = first;
  });

  it('starts pending, with no document yet', async () => {
    const portalCase = await getPortalCase(granted.client, granted.participantId);
    const requirement = portalCase?.requirements.find((r) => r.id === requirementId);

    expect(requirement?.state).toBe('pending');
  });

  it('moves to rejected, with the reviewer\'s reason, after a rejected review', async () => {
    const uploaded = await registerDocument(
      granted.client,
      {
        organizationId: world.organizationId,
        caseId: world.caseId,
        requirementId,
        fileName: 'first-attempt.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );

    await decideReview(
      world.staff.client,
      { documentId: uploaded.documentId, decision: 'rejected', reason: 'Falta la segunda página.' },
      world.staff.userId,
    );

    const portalCase = await getPortalCase(granted.client, granted.participantId);
    const requirement = portalCase?.requirements.find((r) => r.id === requirementId);

    expect(requirement?.state).toBe('rejected');
    expect(requirement?.rejectionReason).toBe('Falta la segunda página.');
  });

  it('moves to review after a re-upload — the stale rejection must not keep winning', async () => {
    await registerDocument(
      granted.client,
      {
        organizationId: world.organizationId,
        caseId: world.caseId,
        requirementId,
        fileName: 'second-attempt.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1024,
      },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );

    const portalCase = await getPortalCase(granted.client, granted.participantId);
    const requirement = portalCase?.requirements.find((r) => r.id === requirementId);

    // This is the regression: before the fix, the old rejected review (attached to the first,
    // superseded Document) was still "the latest review" by timestamp, so this stayed 'rejected'
    // with the old reason forever, even though a fresh, unreviewed Document now exists.
    expect(requirement?.state).toBe('review');
    expect(requirement?.rejectionReason).toBeUndefined();
  });

  it('moves to approved once the re-upload is reviewed, regardless of the earlier rejection', async () => {
    const { data: documents } = await world.staff.client
      .from('documents')
      .select('id, created_at')
      .eq('requirement_id', requirementId)
      .order('created_at', { ascending: false });

    const latestDocumentId = documents?.[0]?.id;
    if (!latestDocumentId) throw new Error('expected the re-uploaded document to exist');

    await decideReview(
      world.staff.client,
      { documentId: latestDocumentId, decision: 'approved' },
      world.staff.userId,
    );

    const portalCase = await getPortalCase(granted.client, granted.participantId);
    const requirement = portalCase?.requirements.find((r) => r.id === requirementId);

    expect(requirement?.state).toBe('approved');
  });
});
