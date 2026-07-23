import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type GrantedClient,
  type OrganizationWorld,
} from '../helpers/fixtures';
import { registerDocument } from '@/features/documents/documents';

async function freshWorld(label: string): Promise<OrganizationWorld> {
  return buildOrganizationWorld({
    name: `Notaría ${label}`,
    industry: 'notary',
    clientEmail: `${label.toLowerCase()}-${randomUUID()}@example.test`,
  });
}

async function notificationsFor(
  world: OrganizationWorld,
  reason: 'review_needed' | 'case_ready',
): Promise<{ target_id: string | null }[]> {
  const { data } = await world.staff.client
    .from('staff_notifications')
    .select('target_id')
    .eq('case_id', world.caseId)
    .eq('reason', reason);
  return data ?? [];
}

async function clientUpload(
  world: OrganizationWorld,
  granted: GrantedClient,
  requirementId: string,
): Promise<string> {
  const { documentId } = await registerDocument(
    granted.client,
    {
      organizationId: world.organizationId,
      caseId: world.caseId,
      requirementId,
      fileName: 'scan.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    },
    { kind: 'client', authUserId: granted.authUserId, grantId: granted.grantId },
  );
  return documentId;
}

describe('staff notifications', () => {
  describe('review_needed on upload', () => {
    it('is created when a client uploads', async () => {
      const world = await freshWorld('ClientUpload');
      const granted = await grantVerifiedAccess({ world });
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      const documentId = await clientUpload(world, granted, requirementId);

      const notifications = await notificationsFor(world, 'review_needed');
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.target_id).toBe(documentId);
    });

    it('is not created when a staff member uploads', async () => {
      const world = await freshWorld('StaffUpload');
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      await registerDocument(
        world.staff.client,
        {
          organizationId: world.organizationId,
          caseId: world.caseId,
          requirementId,
          fileName: 'staff-scan.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
        },
        { kind: 'member', authUserId: world.staff.userId },
      );

      expect(await notificationsFor(world, 'review_needed')).toEqual([]);
    });

    it('references the document by id and stores no contents or url', async () => {
      const world = await freshWorld('NoSecrets');
      const granted = await grantVerifiedAccess({ world });
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      await clientUpload(world, granted, requirementId);

      const { data } = await world.staff.client
        .from('staff_notifications')
        .select('*')
        .eq('case_id', world.caseId)
        .eq('reason', 'review_needed')
        .single();

      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('%PDF');
      expect(serialized).not.toContain('/storage/v1/');
      expect(serialized).not.toMatch(/token=/);
    });
  });

  describe('case_ready on the final approval', () => {
    it('fires only when the last outstanding requirement is satisfied', async () => {
      const world = await freshWorld('FinalApproval');
      // Three requirements from the fixture blueprint.
      const [first, second, third] = world.requirementIds;
      if (!first || !second || !third) throw new Error('fixture requirements missing');

      await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', first);
      expect(await notificationsFor(world, 'case_ready')).toEqual([]);

      await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', second);
      expect(await notificationsFor(world, 'case_ready')).toEqual([]);

      await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', third);
      const ready = await notificationsFor(world, 'case_ready');
      expect(ready).toHaveLength(1);
      expect(ready[0]?.target_id).toBe(world.caseId);
    });

    it('ignores a deleted requirement when deciding readiness', async () => {
      const world = await freshWorld('DeletedReq');
      const [first, second, third] = world.requirementIds;
      if (!first || !second || !third) throw new Error('fixture requirements missing');

      // Delete one; satisfying the other two should now be enough.
      await adminClient()
        .from('requirements')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', third);

      await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', first);
      await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', second);

      expect(await notificationsFor(world, 'case_ready')).toHaveLength(1);
    });
  });

  describe('isolation', () => {
    it('is hidden from clients and other organizations', async () => {
      const world = await freshWorld('Isolated');
      const granted = await grantVerifiedAccess({ world });
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');
      await clientUpload(world, granted, requirementId);

      const other = await freshWorld('Outsider');

      const asClient = await granted.client.from('staff_notifications').select('id');
      expect(asClient.data).toEqual([]);

      const asOtherOrg = await other.staff.client
        .from('staff_notifications')
        .select('id')
        .eq('case_id', world.caseId);
      expect(asOtherOrg.data).toEqual([]);

      const asOwner = await world.staff.client
        .from('staff_notifications')
        .select('id')
        .eq('case_id', world.caseId);
      expect(asOwner.data?.length).toBeGreaterThan(0);
    });
  });
});
