import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildOrganizationWorld, grantVerifiedAccess, type GrantedClient, type OrganizationWorld } from '../helpers/fixtures';
import { closeCase } from '@/features/cases/cases';
import { getPortalCase } from '@/features/case-access/portal-queries';

/**
 * Regression coverage for the Task 9 Client Portal terminal view: once a Case is closed, the
 * portal read model must surface both the outcome (`caseState`) and any optional staff-written
 * `client_closing_note` — including on a *completed* Case, where the note is optional rather than
 * required (unlike `cancelled`, where close_case enforces one). Nothing previously exercised
 * these two fields at all.
 */
describe('portal read model: caseState and clientClosingNote after close_case', () => {
  let world: OrganizationWorld;
  let granted: GrantedClient;
  const closingNote = 'Nota de finalización visible para el cliente.';

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Portal Closed Case',
      industry: 'notary',
      clientEmail: `portal-closed-case-${randomUUID()}@example.test`,
    });
    granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const { error: satisfyError } = await world.staff.client
      .from('requirements')
      .update({ status: 'satisfied' })
      .eq('case_id', world.caseId);
    if (satisfyError) throw new Error(`fixture: could not satisfy requirements: ${satisfyError.message}`);

    await closeCase(world.staff.client, world.caseId, 'completed', closingNote);
  });

  it('reflects the completed outcome and the optional closing note', async () => {
    const portalCase = await getPortalCase(granted.client, granted.participantId);

    expect(portalCase?.caseState).toBe('completed');
    expect(portalCase?.clientClosingNote).toBe(closingNote);
  });
});
