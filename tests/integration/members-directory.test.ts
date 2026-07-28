import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anonClient } from '../helpers/clients';
import { buildOrganizationWorld, buildTwoOrganizationWorld } from '../helpers/fixtures';
import { getOrganizationMembers } from '@/features/members/queries';

describe('getOrganizationMembers', () => {
  it('returns the caller\'s own organization members with email and role', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Miembros',
      industry: 'notary',
      clientEmail: `members-${randomUUID()}@example.test`,
    });

    const rows = await getOrganizationMembers(world.owner.client, world.organizationId);
    const roles = rows.map((r) => r.role).sort();

    expect(rows.map((r) => r.email)).toEqual(
      expect.arrayContaining([world.owner.email, world.staff.email]),
    );
    expect(roles).toEqual(['owner', 'staff']);
  });

  it('lets any active member view the directory, not only the owner', async () => {
    // world.staff (from buildOrganizationWorld) is role='staff', never the owner — this is the
    // product decision under test: viewing is not owner-gated, only inviting would be.
    const world = await buildOrganizationWorld({
      name: 'Notaría Cualquiera',
      industry: 'notary',
      clientEmail: `anyview-${randomUUID()}@example.test`,
    });

    const rows = await getOrganizationMembers(world.staff.client, world.organizationId);

    expect(rows.map((r) => r.email)).toContain(world.owner.email);
  });

  it('returns zero rows for a foreign organization id, never an error', async () => {
    const { a, b } = await buildTwoOrganizationWorld();

    const rows = await getOrganizationMembers(a.owner.client, b.organizationId);

    expect(rows).toEqual([]);
  });

  it('refuses anon execution of the underlying RPC', async () => {
    const { error } = await anonClient().rpc('org_members_with_email', {
      target_organization_id: '00000000-0000-0000-0000-000000000000',
    });

    expect(error).not.toBeNull();
  });
});
