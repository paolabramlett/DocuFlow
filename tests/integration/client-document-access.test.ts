import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOrganizationWorld, grantVerifiedAccess, addParticipant } from '../helpers/fixtures';
import { decideReview, registerDocument } from '@/features/documents/documents';
import { getPortalCase } from '@/features/case-access/portal-queries';
import { getClientDocumentUrl, uploadRequirementDocument } from '@/application/client-portal';
import { CASE_DOCUMENTS_BUCKET } from '@/lib/storage/paths';

describe('client document access — post-approval read-only view/download', () => {
  it('an approved requirement carries documentId/fileName/approvedAt in the read model', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Client Doc Access',
      industry: 'notary',
      clientEmail: `client-doc-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const requirementId = world.requirementIds[0]!;

    const uploaded = await registerDocument(
      granted.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId, fileName: 'ine.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );
    await decideReview(world.staff.client, { documentId: uploaded.documentId, decision: 'approved' }, world.staff.userId);

    const portalCase = await getPortalCase(granted.client, granted.participantId);
    const requirement = portalCase?.requirements.find((r) => r.id === requirementId);

    expect(requirement?.state).toBe('approved');
    expect(requirement?.documentId).toBe(uploaded.documentId);
    expect(requirement?.fileName).toBe('ine.pdf');
    expect(requirement?.approvedAt).toBeTruthy();
  });

  it('the participant can generate a signed URL for their own approved document', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Client Doc Access 2',
      industry: 'notary',
      clientEmail: `client-doc-${randomUUID()}@example.test`,
    });
    const token = `test-token-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const requirementId = world.requirementIds[0]!;
    const uploaded = await registerDocument(
      granted.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId, fileName: 'ine.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );
    // Put a real object at the path so signing has something to sign — registerDocument only
    // writes the DB row (tests/integration/documents.test.ts does the same for this reason).
    await granted.client.storage
      .from(CASE_DOCUMENTS_BUCKET)
      .upload(uploaded.storagePath, new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }));
    await decideReview(world.staff.client, { documentId: uploaded.documentId, decision: 'approved' }, world.staff.userId);

    const url = await getClientDocumentUrl(granted.client, { token, documentId: uploaded.documentId });
    expect(url).toMatch(/^https?:\/\//);
  });

  it('generates a forced-download URL when download is requested', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Client Doc Download',
      industry: 'notary',
      clientEmail: `client-doc-${randomUUID()}@example.test`,
    });
    const token = `test-token-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const requirementId = world.requirementIds[0]!;
    const uploaded = await registerDocument(
      granted.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId, fileName: 'ine.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );
    await granted.client.storage
      .from(CASE_DOCUMENTS_BUCKET)
      .upload(uploaded.storagePath, new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }));
    await decideReview(world.staff.client, { documentId: uploaded.documentId, decision: 'approved' }, world.staff.userId);

    const url = await getClientDocumentUrl(granted.client, { token, documentId: uploaded.documentId, download: true });
    expect(url).toContain('download');
  });

  it("refuses a document belonging to another participant", async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Client Doc Cross',
      industry: 'notary',
      clientEmail: `client-doc-a-${randomUUID()}@example.test`,
    });
    const tokenA = `test-token-a-${randomUUID()}`;
    const grantedA = await grantVerifiedAccess({ world, permission: 'upload', token: tokenA });

    const second = await addParticipant(world, { roleLabel: 'Vendedor', clientEmail: `client-doc-b-${randomUUID()}@example.test` });
    const { data: reqB } = await world.staff.client
      .from('requirements')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        participant_id: second.participantId,
        label: 'Requisito B',
        type: 'document',
        position: 0,
      })
      .select('id')
      .single();
    const grantedB = await grantVerifiedAccess({
      world,
      participantId: second.participantId,
      clientId: second.clientId,
      existingEmail: second.clientEmail,
    });
    const uploadedB = await registerDocument(
      grantedB.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId: reqB!.id, fileName: 'b.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: grantedB.authUserId, grantId: grantedB.grantId },
    );

    await expect(
      getClientDocumentUrl(grantedA.client, { token: tokenA, documentId: uploadedB.documentId }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('refuses to re-upload for an already-approved requirement', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Client Doc Locked',
      industry: 'notary',
      clientEmail: `client-doc-locked-${randomUUID()}@example.test`,
    });
    const token = `test-token-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const requirementId = world.requirementIds[0]!;
    const uploaded = await registerDocument(
      granted.client,
      { organizationId: world.organizationId, caseId: world.caseId, requirementId, fileName: 'ine.pdf', contentType: 'application/pdf', sizeBytes: 100 },
      { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
    );
    await decideReview(world.staff.client, { documentId: uploaded.documentId, decision: 'approved' }, world.staff.userId);

    await expect(
      uploadRequirementDocument(
        granted.client,
        {
          token,
          requirementId,
          fileName: 'ine-again.pdf',
          contentType: 'application/pdf',
          sizeBytes: 100,
          file: new Blob(['test'], { type: 'application/pdf' }),
        },
        granted.authUserId,
      ),
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
});
