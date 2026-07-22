import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type GrantedClient,
  type OrganizationWorld,
} from '../helpers/fixtures';
import { documentObjectPath } from '@/lib/storage/paths';

describe('documents and reviews', () => {
  let world: OrganizationWorld;
  let granted: GrantedClient;
  let requirementId: string;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Docs',
      industry: 'notary',
      clientEmail: `docs-${randomUUID()}@example.test`,
    });
    granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const first = world.requirementIds[0];
    if (!first) throw new Error('fixture requirement missing');
    requirementId = first;
  });

  async function uploadDocument(fileName: string): Promise<string> {
    const documentId = randomUUID();

    const { data, error } = await granted.client
      .from('documents')
      .insert({
        id: documentId,
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: requirementId,
        storage_path: documentObjectPath({
          organizationId: world.organizationId,
          caseId: world.caseId,
          requirementId,
          documentId,
        }),
        file_name: fileName,
        content_type: 'application/pdf',
        size_bytes: 4096,
        uploaded_by_auth_user_id: granted.authUserId,
      })
      .select('id')
      .single();

    if (error || !data) throw new Error(`upload failed: ${error?.message}`);
    return data.id;
  }

  describe('review decisions move the requirement', () => {
    it('marks the requirement satisfied on approval', async () => {
      const documentId = await uploadDocument('approved.pdf');

      const { error } = await world.staff.client.from('reviews').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        document_id: documentId,
        decision: 'approved',
        reviewed_by_auth_user_id: world.staff.userId,
      });
      expect(error).toBeNull();

      const { data } = await world.staff.client
        .from('requirements')
        .select('status')
        .eq('id', requirementId)
        .single();

      expect(data?.status).toBe('satisfied');
    });

    it('returns the requirement to outstanding on rejection, with a client-visible reason', async () => {
      const documentId = await uploadDocument('rejected.pdf');

      await world.staff.client.from('reviews').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        document_id: documentId,
        decision: 'rejected',
        reason: 'Scan is illegible',
        reviewed_by_auth_user_id: world.staff.userId,
      });

      const { data: requirement } = await world.staff.client
        .from('requirements')
        .select('status')
        .eq('id', requirementId)
        .single();
      expect(requirement?.status).toBe('outstanding');

      // The client can read why.
      const { data: visible } = await granted.client
        .from('reviews')
        .select('decision, reason')
        .eq('document_id', documentId);
      expect(visible?.[0]?.reason).toBe('Scan is illegible');
    });

    it('accepts a replacement upload after rejection and preserves both decisions', async () => {
      const replacement = await uploadDocument('replacement.pdf');

      await world.staff.client.from('reviews').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        document_id: replacement,
        decision: 'approved',
        reviewed_by_auth_user_id: world.staff.userId,
      });

      const { data: history } = await world.staff.client
        .from('reviews')
        .select('decision')
        .eq('case_id', world.caseId);

      expect(history?.some((r) => r.decision === 'rejected')).toBe(true);
      expect(history?.some((r) => r.decision === 'approved')).toBe(true);
    });
  });

  describe('who may review', () => {
    it('refuses a review written by a client', async () => {
      const documentId = await uploadDocument('client-review.pdf');

      const { error } = await granted.client.from('reviews').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        document_id: documentId,
        decision: 'approved',
      });

      expect(error).not.toBeNull();
    });

    it('rejects a decision outside approved and rejected', async () => {
      const documentId = await uploadDocument('bad-decision.pdf');

      const { error } = await adminClient()
        .from('reviews')
        .insert({
          organization_id: world.organizationId,
          case_id: world.caseId,
          document_id: documentId,
          decision: 'maybe' as 'approved',
        });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/check constraint/i);
    });
  });

  describe('storage path integrity', () => {
    it('refuses two documents pointing at the same object', async () => {
      const documentId = randomUUID();
      const path = documentObjectPath({
        organizationId: world.organizationId,
        caseId: world.caseId,
        requirementId,
        documentId,
      });

      const insert = () =>
        adminClient().from('documents').insert({
          organization_id: world.organizationId,
          case_id: world.caseId,
          requirement_id: requirementId,
          storage_path: path,
          file_name: 'dup.pdf',
          content_type: 'application/pdf',
          size_bytes: 1,
        });

      expect((await insert()).error).toBeNull();
      expect((await insert()).error).not.toBeNull();
    });

    it('refuses a document whose requirement belongs to another case', async () => {
      const other = await buildOrganizationWorld({
        name: 'Notaría Other',
        industry: 'notary',
        clientEmail: `other-${randomUUID()}@example.test`,
      });
      const foreignRequirement = other.requirementIds[0];
      if (!foreignRequirement) throw new Error('fixture requirement missing');

      const { error } = await adminClient().from('documents').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: foreignRequirement,
        storage_path: `${world.organizationId}/x/${randomUUID()}`,
        file_name: 'foreign.pdf',
        content_type: 'application/pdf',
        size_bytes: 1,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key/i);
    });

    it('rejects a non-positive size', async () => {
      const { error } = await adminClient().from('documents').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: requirementId,
        storage_path: `${world.organizationId}/zero/${randomUUID()}`,
        file_name: 'empty.pdf',
        content_type: 'application/pdf',
        size_bytes: 0,
      });

      expect(error).not.toBeNull();
    });
  });
});
