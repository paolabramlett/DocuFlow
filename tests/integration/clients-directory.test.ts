// tests/integration/clients-directory.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anonClient } from '../helpers/clients';
import { buildOrganizationWorld, buildTwoOrganizationWorld } from '../helpers/fixtures';
import { getClientsDirectory } from '@/features/clients/queries';

describe('getClientsDirectory', () => {
  it("returns the caller's own clients with a distinct case count", async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Directorio',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });

    const rows = await getClientsDirectory(world.staff.client, world.organizationId);
    const primary = rows.find((r) => r.id === world.clientId);

    expect(primary).toBeDefined();
    expect(primary?.email).toBe(world.clientEmail);
    expect(primary?.caseCount).toBe(1);
  });

  it('counts distinct Cases, not participant rows, when a Client is added twice to the same Case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Duplicado',
      industry: 'notary',
      clientEmail: `dup-${randomUUID()}@example.test`,
    });

    // A second participant row for the SAME client on the SAME case — no unique constraint
    // prevents this (case_participants has none on (case_id, client_id)). Before the fix this
    // would inflate caseCount to 2 for a Client on only one Case.
    const { error } = await world.staff.client.from('case_participants').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      client_id: world.clientId,
      role_label: 'Segundo rol',
    });
    expect(error).toBeNull();

    const rows = await getClientsDirectory(world.staff.client, world.organizationId);
    const primary = rows.find((r) => r.id === world.clientId);

    expect(primary?.caseCount).toBe(1);
  });

  it('never returns another organization\'s clients', async () => {
    const { a, b } = await buildTwoOrganizationWorld();

    const rowsForA = await getClientsDirectory(a.staff.client, a.organizationId);
    const rowsForB = await getClientsDirectory(b.staff.client, b.organizationId);

    expect(rowsForA.some((r) => r.id === b.clientId)).toBe(false);
    expect(rowsForB.some((r) => r.id === a.clientId)).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Anon',
      industry: 'notary',
      clientEmail: `anon-${randomUUID()}@example.test`,
    });

    const rows = await getClientsDirectory(anonClient(), world.organizationId);
    expect(rows).toEqual([]);
  });
});
