import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import {
  buildOrganizationWorld,
  buildTwoOrganizationWorld,
  grantVerifiedAccess,
  type OrganizationWorld,
  type TwoOrganizationWorld,
} from '../helpers/fixtures';

async function freshWorld(label: string): Promise<OrganizationWorld> {
  return buildOrganizationWorld({
    name: `Notaría ${label}`,
    industry: 'notary',
    clientEmail: `${label.toLowerCase()}-${randomUUID()}@example.test`,
  });
}

describe('case access grants', () => {
  describe('scope', () => {
    it('reaches exactly one case, never a sibling of the same client', async () => {
      const world = await freshWorld('Scope');
      const granted = await grantVerifiedAccess({ world });

      const { data: sibling } = await world.staff.client.rpc('create_case', {
        target_organization_id: world.organizationId,
        target_client_id: world.clientId,
        case_title: 'Second case, same client',
      });

      const { data } = await granted.client.from('cases').select('id');

      expect(data?.map((row) => row.id)).toEqual([world.caseId]);
      expect(data?.map((row) => row.id)).not.toContain(sibling);
    });

    it('shows the requirements of the granted case only', async () => {
      const world = await freshWorld('Reqs');
      const granted = await grantVerifiedAccess({ world });

      const { data } = await granted.client.from('requirements').select('id');

      expect(data).toHaveLength(3);
      expect(data?.map((r) => r.id).sort()).toEqual([...world.requirementIds].sort());
    });

    it('hides the audit trail from clients entirely', async () => {
      const world = await freshWorld('Audit');
      const granted = await grantVerifiedAccess({ world });

      await adminClient().from('audit_events').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        action: 'case.created',
        target_type: 'case',
        target_id: world.caseId,
        actor_kind: 'system',
      });

      const { data } = await granted.client.from('audit_events').select('id');

      expect(data).toEqual([]);
    });
  });

  describe('permission levels', () => {
    it('lets an upload grant insert a document', async () => {
      const world = await freshWorld('Upload');
      const granted = await grantVerifiedAccess({ world, permission: 'upload' });
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      const { error } = await granted.client.from('documents').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: requirementId,
        storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${requirementId}/${randomUUID()}`,
        file_name: 'id.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
      });

      expect(error).toBeNull();
    });

    it('blocks upload on a view grant while keeping reads working', async () => {
      const world = await freshWorld('ViewOnly');
      const granted = await grantVerifiedAccess({ world, permission: 'view' });
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      const { error } = await granted.client.from('documents').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: requirementId,
        storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${requirementId}/${randomUUID()}`,
        file_name: 'blocked.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
      });

      expect(error).not.toBeNull();

      const { data: readable } = await granted.client.from('cases').select('id');
      expect(readable?.map((r) => r.id)).toEqual([world.caseId]);
    });

    it('blocks every case read on a none grant', async () => {
      const world = await freshWorld('NonePerm');
      const granted = await grantVerifiedAccess({ world, permission: 'none' });

      const { data } = await granted.client.from('cases').select('id');

      expect(data).toEqual([]);
    });
  });

  describe('lifecycle', () => {
    it('denies an expired grant regardless of permission', async () => {
      const world = await freshWorld('Expired');
      const granted = await grantVerifiedAccess({
        world,
        permission: 'upload',
        expiresAt: new Date(Date.now() - 1000),
      });

      const { data } = await granted.client.from('cases').select('id');

      expect(data).toEqual([]);
    });

    it('denies an unverified grant', async () => {
      const world = await freshWorld('Unverified');
      const granted = await grantVerifiedAccess({ world });

      await adminClient()
        .from('case_access_grants')
        .update({ verified_at: null })
        .eq('id', granted.grantId);

      const { data } = await granted.client.from('cases').select('id');

      expect(data).toEqual([]);
    });

    it('ends access on the next request after revocation, without a token refresh', async () => {
      const world = await freshWorld('Revoked');
      const granted = await grantVerifiedAccess({ world });

      const before = await granted.client.from('cases').select('id');
      expect(before.data).toHaveLength(1);

      await world.staff.client
        .from('case_access_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', granted.grantId);

      // Same client, same session, same access token — only the next request differs.
      const after = await granted.client.from('cases').select('id');
      expect(after.data).toEqual([]);
    });
  });

  describe('case completion', () => {
    it('downgrades an upload grant to view using the organization retention window', async () => {
      const world = await freshWorld('Complete');
      const granted = await grantVerifiedAccess({ world, permission: 'upload' });

      await world.staff.client
        .from('cases')
        .update({ state: 'completed', closed_at: new Date().toISOString() })
        .eq('id', world.caseId);

      const { data: grant } = await adminClient()
        .from('case_access_grants')
        .select('permission, expires_at')
        .eq('id', granted.grantId)
        .single();

      expect(grant?.permission).toBe('view');

      const expiresAt = new Date(grant?.expires_at ?? 0).getTime();
      const expectedDays = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
      expect(expectedDays).toBeGreaterThan(89);
      expect(expectedDays).toBeLessThan(91);
    });

    it('honours a different retention policy without any code change', async () => {
      const world = await freshWorld('Retention');
      await adminClient()
        .from('organizations')
        .update({ access_retention_days: 7 })
        .eq('id', world.organizationId);

      const granted = await grantVerifiedAccess({ world, permission: 'upload' });

      await world.staff.client
        .from('cases')
        .update({ state: 'completed', closed_at: new Date().toISOString() })
        .eq('id', world.caseId);

      const { data: grant } = await adminClient()
        .from('case_access_grants')
        .select('expires_at')
        .eq('id', granted.grantId)
        .single();

      const days = (new Date(grant?.expires_at ?? 0).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6);
      expect(days).toBeLessThan(8);
    });

    it('refuses further uploads once the case is complete', async () => {
      const world = await freshWorld('NoUpload');
      const granted = await grantVerifiedAccess({ world, permission: 'upload' });
      const requirementId = world.requirementIds[0];
      if (!requirementId) throw new Error('fixture requirement missing');

      await world.staff.client
        .from('cases')
        .update({ state: 'completed', closed_at: new Date().toISOString() })
        .eq('id', world.caseId);

      const { error } = await granted.client.from('documents').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: requirementId,
        storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${requirementId}/${randomUUID()}`,
        file_name: 'late.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
      });

      expect(error).not.toBeNull();
    });
  });

  describe('one identity across two organizations', () => {
    let world: TwoOrganizationWorld;

    beforeAll(async () => {
      world = await buildTwoOrganizationWorld();
    });

    it('creates two independent client records for the same email', async () => {
      const inA = await world.a.owner.client
        .from('clients')
        .select('id, email')
        .eq('email', world.sharedClientEmail);
      const inB = await world.b.owner.client
        .from('clients')
        .select('id, email')
        .eq('email', world.sharedClientEmail);

      expect(inA.data).toHaveLength(1);
      expect(inB.data).toHaveLength(1);
      expect(inA.data?.[0]?.id).not.toBe(inB.data?.[0]?.id);
    });

    it('lets one identity hold a grant in each organization, seeing each independently', async () => {
      const inA = await grantVerifiedAccess({ world: world.a });
      const inB = await grantVerifiedAccess({
        world: world.b,
        existingAuthUserId: inA.authUserId,
        existingEmail: world.sharedClientEmail,
      });

      const fromA = await inA.client.from('cases').select('id');
      const fromB = await inB.client.from('cases').select('id');

      // Same human. Both grants resolve, and each session sees both granted cases — but never a
      // case, client, or organization it was not granted.
      expect(fromA.data?.map((r) => r.id).sort()).toEqual([world.a.caseId, world.b.caseId].sort());
      expect(fromB.data?.map((r) => r.id).sort()).toEqual([world.a.caseId, world.b.caseId].sort());

      const { data: visibleClients } = await inA.client.from('clients').select('id');
      expect(visibleClients).toEqual([]);

      const { data: visibleOrgs } = await inA.client.from('organizations').select('id');
      expect(visibleOrgs).toEqual([]);
    });

    it('leaves the other organization untouched when one revokes', async () => {
      // Its own pair of worlds: the tests above leave active grants on the shared world, and a
      // revocation here would not close those, which would look like a leak but is fixture bleed.
      const pair = await buildTwoOrganizationWorld();

      const inA = await grantVerifiedAccess({ world: pair.a });
      const inB = await grantVerifiedAccess({
        world: pair.b,
        existingAuthUserId: inA.authUserId,
        existingEmail: pair.sharedClientEmail,
      });

      await pair.a.staff.client
        .from('case_access_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', inA.grantId);

      const remaining = await inB.client.from('cases').select('id');

      expect(remaining.data?.map((r) => r.id)).toEqual([pair.b.caseId]);
    });
  });
});
