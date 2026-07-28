// tests/integration/update-organization.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { updateOrganization } from '@/application/update-organization';
import { UseCaseError } from '@/application/errors';

describe('updateOrganization', () => {
  it('lets the owner update name and industry, logging exactly one event', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Original',
      industry: 'notary',
      clientEmail: `owner-update-${randomUUID()}@example.test`,
    });

    await updateOrganization(
      world.owner.client,
      { organizationId: world.organizationId, name: 'Notaría Renombrada', industry: 'legal' },
      { authUserId: world.owner.userId },
    );

    const { data: org } = await adminClient()
      .from('organizations')
      .select('name, industry')
      .eq('id', world.organizationId)
      .single();
    expect(org?.name).toBe('Notaría Renombrada');
    expect(org?.industry).toBe('legal');

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('id')
      .eq('organization_id', world.organizationId)
      .eq('action', 'organization.updated');
    expect(events).toHaveLength(1);
  });

  it('refuses a non-owner staff member via the use case\'s own ActorContext check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Staff Refused',
      industry: 'notary',
      clientEmail: `staff-refused-${randomUUID()}@example.test`,
    });

    await expect(
      updateOrganization(
        world.staff.client,
        { organizationId: world.organizationId, name: 'Intento no autorizado', industry: 'legal' },
        { authUserId: world.staff.userId },
      ),
    ).rejects.toMatchObject({ reason: 'forbidden' });

    await expect(
      updateOrganization(
        world.staff.client,
        { organizationId: world.organizationId, name: 'Intento no autorizado', industry: 'legal' },
        { authUserId: world.staff.userId },
      ),
    ).rejects.toBeInstanceOf(UseCaseError);
  });

  it('also refuses a non-owner at the RLS floor, independent of the use case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría RLS Floor',
      industry: 'notary',
      clientEmail: `rls-floor-${randomUUID()}@example.test`,
    });

    // Bypasses the use case entirely — proves organizations_update_by_owner holds even if the
    // application-layer check above had a bug.
    const { error, data } = await world.staff.client
      .from('organizations')
      .update({ name: 'Should not apply' })
      .eq('id', world.organizationId)
      .select();

    expect(data ?? []).toEqual([]);
    expect(error).toBeNull(); // RLS silently matches zero rows rather than erroring
  });

  it('never modifies existing Cases when only industry changes', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Industria',
      industry: 'notary',
      clientEmail: `industry-${randomUUID()}@example.test`,
    });

    const { data: before } = await adminClient()
      .from('cases')
      .select('id, title, state')
      .eq('id', world.caseId)
      .single();

    await updateOrganization(
      world.owner.client,
      { organizationId: world.organizationId, name: 'Notaría Industria', industry: 'accounting' },
      { authUserId: world.owner.userId },
    );

    const { data: after } = await adminClient()
      .from('cases')
      .select('id, title, state')
      .eq('id', world.caseId)
      .single();

    expect(after).toEqual(before);
  });
});
