import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { getOperativeCounts, type CaseView } from '@/features/cases/queries';
import { closeCase } from '@/features/cases/cases';

/** A minimal, otherwise-valid CaseView — only `state` and `participants` matter to
 *  getOperativeCounts's in-memory buckets; the rest is filler to satisfy the type. */
function caseView(overrides: Partial<CaseView> & Pick<CaseView, 'state' | 'participants'>): CaseView {
  return { id: randomUUID(), ref: 'CASE-TEST', title: 'Test', opened: '1 ene 2026', ...overrides };
}

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

describe('getOperativeCounts: state === "open" guard on waitingClient/needsReview/readyToContinue', () => {
  it('excludes a closed Case from needsReview even though its Requirement is still "review"', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Closed NeedsReview',
      industry: 'notary',
      clientEmail: `metric-closed-review-${randomUUID()}@example.test`,
    });
    const closedCase = caseView({
      state: 'completed',
      participants: [{ id: 'p1', name: 'X', role: 'Cliente', requirements: [{ id: 'r1', label: 'R', state: 'review' }] }],
    });

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, [closedCase]);

    expect(counts.needsReview).toBe(0);
  });

  it('excludes a closed Case from waitingClient even though its Requirement is "missing"', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Closed WaitingClient',
      industry: 'notary',
      clientEmail: `metric-closed-waiting-${randomUUID()}@example.test`,
    });
    const closedCase = caseView({
      state: 'cancelled',
      participants: [{ id: 'p1', name: 'X', role: 'Cliente', requirements: [{ id: 'r1', label: 'R', state: 'missing' }] }],
    });

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, [closedCase]);

    expect(counts.waitingClient).toBe(0);
  });

  it('excludes a closed Case from readyToContinue even though every Requirement is "approved"', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Closed ReadyToContinue',
      industry: 'notary',
      clientEmail: `metric-closed-ready-${randomUUID()}@example.test`,
    });
    const closedCase = caseView({
      state: 'completed',
      participants: [{ id: 'p1', name: 'X', role: 'Cliente', requirements: [{ id: 'r1', label: 'R', state: 'approved' }] }],
    });

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, [closedCase]);

    expect(counts.readyToContinue).toBe(0);
  });

  it('still counts the equivalent open Case in all three buckets (control, proves the guard is real)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Metric Open Control',
      industry: 'notary',
      clientEmail: `metric-open-control-${randomUUID()}@example.test`,
    });
    const openReview = caseView({
      state: 'open',
      participants: [{ id: 'p1', name: 'X', role: 'Cliente', requirements: [{ id: 'r1', label: 'R', state: 'review' }] }],
    });
    const openWaiting = caseView({
      state: 'open',
      participants: [{ id: 'p2', name: 'Y', role: 'Cliente', requirements: [{ id: 'r2', label: 'R', state: 'missing' }] }],
    });
    const openReady = caseView({
      state: 'open',
      participants: [{ id: 'p3', name: 'Z', role: 'Cliente', requirements: [{ id: 'r3', label: 'R', state: 'approved' }] }],
    });

    const counts = await getOperativeCounts(world.staff.client, world.organizationId, [openReview, openWaiting, openReady]);

    expect(counts.needsReview).toBe(1);
    expect(counts.waitingClient).toBe(1);
    expect(counts.readyToContinue).toBe(1);
  });
});
