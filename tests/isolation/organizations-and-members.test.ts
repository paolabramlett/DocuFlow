import { beforeAll, describe, expect, it } from 'vitest';
import {
  addStaffMember,
  adminClient,
  anonClient,
  createOrganizationWithOwner,
  createTestUser,
  type TestUser,
} from '../helpers/clients';

describe('organization tenancy', () => {
  let orgA: string;
  let orgB: string;
  let ownerA: TestUser;
  let ownerB: TestUser;
  let staffA: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    const a = await createOrganizationWithOwner('Notaría A', 'notary');
    const b = await createOrganizationWithOwner('Contaduría B', 'accounting');

    orgA = a.organizationId;
    orgB = b.organizationId;
    ownerA = a.owner;
    ownerB = b.owner;

    staffA = await addStaffMember(ownerA, orgA);
    outsider = await createTestUser('outsider');
  });

  describe('the resolvers', () => {
    it('reports only the organizations the caller belongs to', async () => {
      const { data, error } = await ownerA.client.from('organizations').select('id');

      expect(error).toBeNull();
      expect(data?.map((row) => row.id)).toEqual([orgA]);
    });

    it('reports nothing for a user with no membership', async () => {
      const { data, error } = await outsider.client.from('organizations').select('id');

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('cross-organization reads', () => {
    it('returns zero rows when a member selects another organization by id', async () => {
      const { data, error } = await ownerA.client
        .from('organizations')
        .select('id')
        .eq('id', orgB);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('does not disclose existence: a real foreign id looks like a nonexistent one', async () => {
      const nonexistent = '00000000-0000-4000-8000-000000000000';

      const foreign = await ownerA.client.from('organizations').select('id').eq('id', orgB);
      const absent = await ownerA.client.from('organizations').select('id').eq('id', nonexistent);

      expect(foreign.error).toEqual(absent.error);
      expect(foreign.data).toEqual(absent.data);
      expect(foreign.status).toEqual(absent.status);
    });

    it('hides members of another organization', async () => {
      const { data, error } = await ownerA.client
        .from('members')
        .select('id')
        .eq('organization_id', orgB);

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  describe('cross-organization writes', () => {
    it('affects zero rows when updating another organization', async () => {
      const { data, error } = await ownerA.client
        .from('organizations')
        .update({ name: 'Renamed by A' })
        .eq('id', orgB)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);

      // Confirm through the service role that nothing actually changed.
      const { data: actual } = await adminClient()
        .from('organizations')
        .select('name')
        .eq('id', orgB)
        .single();

      expect(actual?.name).toBe('Contaduría B');
    });

    it('refuses to add a member to another organization', async () => {
      const { error } = await ownerA.client.from('members').insert({
        organization_id: orgB,
        user_id: outsider.userId,
        role: 'staff',
      });

      expect(error).not.toBeNull();
    });
  });

  describe('roles', () => {
    it('lets an owner add a member to their own organization', async () => {
      const extra = await createTestUser('extra');

      const { error } = await ownerA.client.from('members').insert({
        organization_id: orgA,
        user_id: extra.userId,
        role: 'staff',
      });

      expect(error).toBeNull();
    });

    it('refuses to let staff add a member', async () => {
      const extra = await createTestUser('extra');

      const { error } = await staffA.client.from('members').insert({
        organization_id: orgA,
        user_id: extra.userId,
        role: 'staff',
      });

      expect(error).not.toBeNull();
    });

    it('refuses to let staff update the organization', async () => {
      const { data, error } = await staffA.client
        .from('organizations')
        .update({ name: 'Renamed by staff' })
        .eq('id', orgA)
        .select();

      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('rejects a role outside owner and staff', async () => {
      const extra = await createTestUser('extra');

      const { error } = await adminClient()
        .from('members')
        // Deliberately invalid: the check constraint is the assertion under test.
        .insert({
          organization_id: orgA,
          user_id: extra.userId,
          role: 'admin' as 'owner',
        });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/check constraint/i);
    });
  });

  describe('multi-organization membership', () => {
    it('keeps two memberships of one user independent', async () => {
      const shared = await createTestUser('shared');

      await ownerA.client
        .from('members')
        .insert({ organization_id: orgA, user_id: shared.userId, role: 'staff' });
      await ownerB.client
        .from('members')
        .insert({ organization_id: orgB, user_id: shared.userId, role: 'staff' });

      const { data } = await shared.client.from('organizations').select('id');

      expect(data?.map((row) => row.id).sort()).toEqual([orgA, orgB].sort());
    });
  });

  describe('unauthenticated access', () => {
    it('returns nothing to an anonymous caller', async () => {
      const { data } = await anonClient().from('organizations').select('id');

      expect(data ?? []).toEqual([]);
    });

    it('refuses organization creation without authentication', async () => {
      const { error } = await anonClient().rpc('create_organization', {
        organization_name: 'Anonymous Org',
        organization_industry: 'notary',
      });

      expect(error).not.toBeNull();
    });
  });
});
