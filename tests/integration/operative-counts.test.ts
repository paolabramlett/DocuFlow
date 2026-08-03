import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { getOperativeCounts } from '@/features/cases/queries';
import { closeCase } from '@/features/cases/cases';

async function completeAllRequirements(world: Awaited<ReturnType<typeof buildOrganizationWorld>>) {
  for (const id of world.requirementIds) {
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
  }
}

describe('getOperativeCounts: completedToday', () => {
  it('counts a Case completed today', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Today',
      industry: 'notary',
      clientEmail: `metric-today-${randomUUID()}@example.test`,
    });
    await completeAllRequirements(world);
    await closeCase(world.staff.client, world.caseId, 'completed', undefined);

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, []);

    expect(counts.completedToday).toBe(1);
  });

  it('never counts a cancelled Case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Cancelled',
      industry: 'notary',
      clientEmail: `metric-cancelled-${randomUUID()}@example.test`,
    });
    await closeCase(world.staff.client, world.caseId, 'cancelled', 'No continúa.');

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, []);

    expect(counts.completedToday).toBe(0);
  });
});
