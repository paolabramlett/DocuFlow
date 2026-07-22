import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestUser } from '../helpers/clients';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type OrganizationWorld,
} from '../helpers/fixtures';
import {
  addRequirement,
  createCase,
  deleteRequirement,
  renameRequirement,
  reorderRequirements,
  setCaseState,
} from '@/features/cases/cases';
import {
  OrganizationAccessError,
  requireOrganizationContext,
  requireOwner,
} from '@/features/organizations/context';
import { ValidationError } from '@/lib/validation/parse';

describe('case services', () => {
  let world: OrganizationWorld;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Services',
      industry: 'notary',
      clientEmail: `svc-${randomUUID()}@example.test`,
    });
  });

  async function auditActions(caseId: string): Promise<string[]> {
    const { data } = await world.staff.client
      .from('audit_events')
      .select('action')
      .eq('case_id', caseId);
    return (data ?? []).map((row) => row.action);
  }

  describe('every consequential action leaves a trail', () => {
    it('records case creation and state change', async () => {
      const caseId = await createCase(
        world.staff.client,
        {
          organizationId: world.organizationId,
          clientId: world.clientId,
          title: 'Audited case',
        },
        world.staff.userId,
      );

      await setCaseState(world.staff.client, caseId, 'completed', world.staff.userId);

      expect(await auditActions(caseId)).toEqual(
        expect.arrayContaining(['case.created', 'case.state_changed']),
      );
    });

    it('records requirement add, rename, reorder, and delete', async () => {
      const caseId = await createCase(
        world.staff.client,
        {
          organizationId: world.organizationId,
          clientId: world.clientId,
          title: 'Requirement lifecycle',
        },
        world.staff.userId,
      );

      const first = await addRequirement(
        world.staff.client,
        { organizationId: world.organizationId, caseId, label: 'Deed', position: 0 },
        world.staff.userId,
      );
      const second = await addRequirement(
        world.staff.client,
        { organizationId: world.organizationId, caseId, label: 'ID', position: 1 },
        world.staff.userId,
      );

      await renameRequirement(
        world.staff.client,
        { requirementId: first, label: 'Signed deed' },
        world.staff.userId,
      );
      await reorderRequirements(
        world.staff.client,
        { caseId, orderedRequirementIds: [second, first] },
        world.staff.userId,
      );
      await deleteRequirement(world.staff.client, second, world.staff.userId);

      expect(await auditActions(caseId)).toEqual(
        expect.arrayContaining([
          'requirement.added',
          'requirement.renamed',
          'requirement.reordered',
          'requirement.deleted',
        ]),
      );

      // Reorder took effect, and the deleted one is gone from the active view but still audited.
      const { data: active } = await world.staff.client
        .from('active_requirements')
        .select('id')
        .eq('case_id', caseId)
        .order('position');
      expect(active?.map((r) => r.id)).toEqual([first]);
    });

    it('snapshots the label so a deletion still reads sensibly later', async () => {
      const caseId = await createCase(
        world.staff.client,
        { organizationId: world.organizationId, clientId: world.clientId, title: 'Snapshot' },
        world.staff.userId,
      );
      const requirementId = await addRequirement(
        world.staff.client,
        { organizationId: world.organizationId, caseId, label: 'Utility bill', position: 0 },
        world.staff.userId,
      );

      await deleteRequirement(world.staff.client, requirementId, world.staff.userId);

      const { data } = await world.staff.client
        .from('audit_events')
        .select('metadata')
        .eq('target_id', requirementId)
        .eq('action', 'requirement.deleted')
        .single();

      expect(data?.metadata).toEqual({ label: 'Utility bill' });
    });
  });

  describe('input validation', () => {
    it('refuses an unimplemented requirement type before reaching the database', async () => {
      await expect(
        addRequirement(
          world.staff.client,
          {
            organizationId: world.organizationId,
            caseId: world.caseId,
            label: 'Signature',
            position: 0,
            type: 'signature' as 'document',
          },
          world.staff.userId,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('refuses a blank case title', async () => {
      await expect(
        createCase(
          world.staff.client,
          { organizationId: world.organizationId, clientId: world.clientId, title: '   ' },
          world.staff.userId,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('organization context', () => {
    it('resolves the role for a member', async () => {
      const context = await requireOrganizationContext(
        world.staff.client,
        world.organizationId,
      );

      expect(context.role).toBe('staff');
      expect(context.authUserId).toBe(world.staff.userId);
    });

    it('refuses a non-member with the same error as a nonexistent organization', async () => {
      const outsider = await createTestUser('outsider');
      const nonexistent = '00000000-0000-4000-8000-000000000000';

      const forReal = await requireOrganizationContext(
        outsider.client,
        world.organizationId,
      ).catch((error: unknown) => error);
      const forAbsent = await requireOrganizationContext(outsider.client, nonexistent).catch(
        (error: unknown) => error,
      );

      expect(forReal).toBeInstanceOf(OrganizationAccessError);
      expect(forAbsent).toBeInstanceOf(OrganizationAccessError);
      expect((forReal as Error).message).toBe((forAbsent as Error).message);
    });

    it('refuses a granted client, who is not a member of anything', async () => {
      const granted = await grantVerifiedAccess({ world });

      await expect(
        requireOrganizationContext(granted.client, world.organizationId),
      ).rejects.toBeInstanceOf(OrganizationAccessError);
    });

    it('gates owner-only operations', async () => {
      const staffContext = await requireOrganizationContext(
        world.staff.client,
        world.organizationId,
      );
      const ownerContext = await requireOrganizationContext(
        world.owner.client,
        world.organizationId,
      );

      expect(() => requireOwner(staffContext)).toThrow(OrganizationAccessError);
      expect(requireOwner(ownerContext).role).toBe('owner');
    });
  });
});
