import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { anonClient } from '../helpers/clients';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type GrantedClient,
  type OrganizationWorld,
} from '../helpers/fixtures';
import {
  createDocumentDownloadUrl,
  decideReview,
  registerDocument,
} from '@/features/documents/documents';
import { MAX_DOCUMENT_BYTES } from '@/features/documents/schemas';
import { ValidationError } from '@/lib/validation/parse';
import { CASE_DOCUMENTS_BUCKET } from '@/lib/storage/paths';

describe('document upload and delivery', () => {
  let world: OrganizationWorld;
  let otherWorld: OrganizationWorld;
  let granted: GrantedClient;
  let requirementId: string;
  let documentId: string;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Upload',
      industry: 'notary',
      clientEmail: `upload-${randomUUID()}@example.test`,
    });
    otherWorld = await buildOrganizationWorld({
      name: 'Contaduría Other',
      industry: 'accounting',
      clientEmail: `other-${randomUUID()}@example.test`,
    });

    granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const first = world.requirementIds[0];
    if (!first) throw new Error('fixture requirement missing');
    requirementId = first;

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
    documentId = uploaded.documentId;

    // Put a real object at the path so signing has something to sign.
    await granted.client.storage
      .from(CASE_DOCUMENTS_BUCKET)
      .upload(uploaded.storagePath, new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }));
  });

  describe('validation before anything is created', () => {
    it('refuses a disallowed content type', async () => {
      await expect(
        registerDocument(
          granted.client,
          {
            organizationId: world.organizationId,
            caseId: world.caseId,
            requirementId,
            fileName: 'payload.exe',
            contentType: 'application/x-msdownload' as 'application/pdf',
            sizeBytes: 1024,
          },
          { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses an oversized file', async () => {
      await expect(
        registerDocument(
          granted.client,
          {
            organizationId: world.organizationId,
            caseId: world.caseId,
            requirementId,
            fileName: 'huge.pdf',
            contentType: 'application/pdf',
            sizeBytes: MAX_DOCUMENT_BYTES + 1,
          },
          { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('creates no row when validation fails', async () => {
      const { data } = await world.staff.client
        .from('documents')
        .select('file_name')
        .eq('case_id', world.caseId);

      expect(data?.map((row) => row.file_name)).not.toContain('payload.exe');
      expect(data?.map((row) => row.file_name)).not.toContain('huge.pdf');
    });
  });

  describe('signed URLs', () => {
    it('issues one to a member of the owning organization', async () => {
      const url = await createDocumentDownloadUrl(world.staff.client, documentId);

      expect(url).toContain('/storage/v1/');
      expect(url).toContain('token=');
    });

    it('issues one to the granted client', async () => {
      const url = await createDocumentDownloadUrl(granted.client, documentId);
      expect(url).toContain('token=');
    });

    it('refuses a member of another organization', async () => {
      await expect(
        createDocumentDownloadUrl(otherWorld.staff.client, documentId),
      ).rejects.toThrow(/No such document|refused|sign/i);
    });

    it('refuses an unauthenticated caller', async () => {
      await expect(createDocumentDownloadUrl(anonClient(), documentId)).rejects.toThrow();
    });

    it('does not persist the URL anywhere', async () => {
      const url = await createDocumentDownloadUrl(world.staff.client, documentId);
      const token = new URL(url).searchParams.get('token') ?? '';

      const { data: documents } = await world.staff.client
        .from('documents')
        .select('storage_path, file_name');
      const { data: events } = await world.staff.client.from('audit_events').select('metadata');

      expect(JSON.stringify(documents)).not.toContain(token);
      expect(JSON.stringify(events)).not.toContain(token);
    });
  });

  describe('direct object access', () => {
    it('refuses an unauthenticated read of the object path', async () => {
      const { data: document } = await world.staff.client
        .from('documents')
        .select('storage_path')
        .eq('id', documentId)
        .single();

      const { data, error } = await anonClient()
        .storage.from(CASE_DOCUMENTS_BUCKET)
        .download(document?.storage_path ?? '');

      expect(data).toBeNull();
      expect(error).not.toBeNull();
    });

    it('refuses a cross-tenant read of the object path', async () => {
      const { data: document } = await world.staff.client
        .from('documents')
        .select('storage_path')
        .eq('id', documentId)
        .single();

      const { error } = await otherWorld.staff.client
        .storage.from(CASE_DOCUMENTS_BUCKET)
        .download(document?.storage_path ?? '');

      expect(error).not.toBeNull();
    });
  });

  describe('review decisions', () => {
    it('satisfies the requirement on approval and audits the decision', async () => {
      await decideReview(
        world.staff.client,
        { documentId, decision: 'approved' },
        world.staff.userId,
      );

      const { data: requirement } = await world.staff.client
        .from('requirements')
        .select('status')
        .eq('id', requirementId)
        .single();
      expect(requirement?.status).toBe('satisfied');

      const { data: events } = await world.staff.client
        .from('audit_events')
        .select('metadata')
        .eq('action', 'review.decided')
        .eq('target_id', documentId);
      expect(events).toHaveLength(1);
    });

    it('reopens the requirement on rejection while keeping both decisions', async () => {
      await decideReview(
        world.staff.client,
        { documentId, decision: 'rejected', reason: 'Illegible' },
        world.staff.userId,
      );

      const { data: requirement } = await world.staff.client
        .from('requirements')
        .select('status')
        .eq('id', requirementId)
        .single();
      expect(requirement?.status).toBe('outstanding');

      const { data: history } = await world.staff.client
        .from('reviews')
        .select('decision')
        .eq('document_id', documentId);
      expect(history?.map((r) => r.decision).sort()).toEqual(['approved', 'rejected']);
    });

    it('refuses a review written by a client', async () => {
      await expect(
        decideReview(granted.client, { documentId, decision: 'approved' }, granted.authUserId),
      ).rejects.toThrow();
    });
  });
});
