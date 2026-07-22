import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type GrantedClient,
  type OrganizationWorld,
} from '../helpers/fixtures';

describe('audit trail', () => {
  let world: OrganizationWorld;
  let granted: GrantedClient;
  let eventId: string;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Audit',
      industry: 'notary',
      clientEmail: `audit-${randomUUID()}@example.test`,
    });
    granted = await grantVerifiedAccess({ world });

    const { data, error } = await world.staff.client
      .from('audit_events')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        action: 'case.created',
        target_type: 'case',
        target_id: world.caseId,
        actor_kind: 'member',
        actor_auth_user_id: world.staff.userId,
      })
      .select('id')
      .single();

    if (error || !data) throw new Error(`audit seed failed: ${error?.message}`);
    eventId = data.id;
  });

  describe('immutability', () => {
    it('denies update to a member', async () => {
      const { error } = await world.staff.client
        .from('audit_events')
        .update({ action: 'case.tampered' })
        .eq('id', eventId);

      expect(error).not.toBeNull();
    });

    it('denies delete to a member', async () => {
      const { error } = await world.staff.client
        .from('audit_events')
        .delete()
        .eq('id', eventId);

      expect(error).not.toBeNull();

      const { data } = await adminClient().from('audit_events').select('id').eq('id', eventId);
      expect(data).toHaveLength(1);
    });

    it('denies update and delete even to the service role', async () => {
      const update = await adminClient()
        .from('audit_events')
        .update({ action: 'tampered' })
        .eq('id', eventId);
      const remove = await adminClient().from('audit_events').delete().eq('id', eventId);

      expect(update.error).not.toBeNull();
      expect(remove.error).not.toBeNull();
    });
  });

  describe('outliving the subject', () => {
    it('keeps events readable after the requirement they describe is deleted', async () => {
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      await world.staff.client.from('audit_events').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        action: 'requirement.deleted',
        target_type: 'requirement',
        target_id: requirementId,
        actor_kind: 'member',
        actor_auth_user_id: world.staff.userId,
        metadata: { label: 'Identity document' },
      });

      // Hard delete, the harshest case: even with the row gone, the trail must survive.
      await adminClient().from('requirements').delete().eq('id', requirementId);

      const { data } = await world.staff.client
        .from('audit_events')
        .select('action, target_id, metadata')
        .eq('target_id', requirementId);

      expect(data).toHaveLength(1);
      expect(data?.[0]?.metadata).toEqual({ label: 'Identity document' });
    });
  });

  describe('actor attribution', () => {
    it('records a client acting through a grant', async () => {
      const { error } = await granted.client.from('audit_events').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        action: 'document.uploaded',
        target_type: 'document',
        target_id: randomUUID(),
        actor_kind: 'client',
        actor_auth_user_id: granted.authUserId,
        actor_grant_id: granted.grantId,
      });

      expect(error).toBeNull();
    });

    it('records a system actor with no user', async () => {
      const { error } = await adminClient().from('audit_events').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        action: 'grants.downgraded',
        target_type: 'case',
        target_id: world.caseId,
        actor_kind: 'system',
      });

      expect(error).toBeNull();
    });

    it('refuses a member or client actor with no user attached', async () => {
      const { error } = await adminClient().from('audit_events').insert({
        organization_id: world.organizationId,
        action: 'case.created',
        target_type: 'case',
        actor_kind: 'member',
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/audit_actor_is_attributable/i);
    });

    it('refuses a system actor carrying a user', async () => {
      const { error } = await adminClient().from('audit_events').insert({
        organization_id: world.organizationId,
        action: 'case.created',
        target_type: 'case',
        actor_kind: 'system',
        actor_auth_user_id: world.staff.userId,
      });

      expect(error).not.toBeNull();
    });

    it('refuses a grant on a non-client actor', async () => {
      const { error } = await adminClient().from('audit_events').insert({
        organization_id: world.organizationId,
        action: 'case.created',
        target_type: 'case',
        actor_kind: 'member',
        actor_auth_user_id: world.staff.userId,
        actor_grant_id: granted.grantId,
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/audit_grant_only_for_client/i);
    });
  });

  describe('visibility', () => {
    it('hides the trail from clients', async () => {
      const { data } = await granted.client.from('audit_events').select('id');
      expect(data).toEqual([]);
    });
  });
});
