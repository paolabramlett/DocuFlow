import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, type OrganizationWorld } from '../helpers/fixtures';
import { renameRequirement, supersedeRequirement } from '@/features/cases/cases';

describe('requirement supersession (design.md D7)', () => {
  let world: OrganizationWorld;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Supersede',
      industry: 'notary',
      clientEmail: `sup-${randomUUID()}@example.test`,
    });
  });

  it('archives the original with a successor pointer and preserves its documents', async () => {
    const original = world.requirementIds[0]!;

    // Satisfy the original and attach a document, standing in for a completed requirement.
    const documentId = randomUUID();
    await adminClient().from('documents').insert({
      id: documentId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: original,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${original}/${documentId}`,
      file_name: 'ine.pdf',
      content_type: 'application/pdf',
      size_bytes: 1024,
    });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', original);

    // Material change: national ID -> passport.
    const successorId = await supersedeRequirement(
      world.staff.client,
      { requirementId: original, label: 'Passport' },
      world.staff.userId,
    );

    const { data: originalRow } = await adminClient()
      .from('requirements')
      .select('status, superseded_at, superseded_by_requirement_id')
      .eq('id', original)
      .single();
    expect(originalRow?.status).toBe('archived');
    expect(originalRow?.superseded_at).not.toBeNull();
    expect(originalRow?.superseded_by_requirement_id).toBe(successorId);

    const { data: successor } = await adminClient()
      .from('requirements')
      .select('status, label')
      .eq('id', successorId)
      .single();
    expect(successor?.status).toBe('outstanding');
    expect(successor?.label).toBe('Passport');

    // The original's document is still linked to the original, not moved.
    const { data: doc } = await adminClient()
      .from('documents')
      .select('requirement_id')
      .eq('id', documentId)
      .single();
    expect(doc?.requirement_id).toBe(original);

    // The audit records the relationship.
    const { data: events } = await world.staff.client
      .from('audit_events')
      .select('metadata')
      .eq('target_id', original)
      .eq('action', 'requirement.superseded');
    expect(events).toHaveLength(1);
    expect((events?.[0]?.metadata as { supersededBy?: string })?.supersededBy).toBe(successorId);
  });

  it('drops the archived original out of the active view', async () => {
    const original = world.requirementIds[1]!;
    await supersedeRequirement(
      world.staff.client,
      { requirementId: original, label: 'Replacement' },
      world.staff.userId,
    );

    const { data: active } = await world.staff.client
      .from('active_requirements')
      .select('id')
      .eq('id', original);
    expect(active).toEqual([]);
  });

  it('a cosmetic rename stays in place — no supersession', async () => {
    const target = world.requirementIds[2]!;
    await renameRequirement(
      world.staff.client,
      { requirementId: target, label: 'Signed mandate (corrected)' },
      world.staff.userId,
    );

    const { data } = await adminClient()
      .from('requirements')
      .select('label, superseded_at, status')
      .eq('id', target)
      .single();
    expect(data?.label).toBe('Signed mandate (corrected)');
    expect(data?.superseded_at).toBeNull();
    expect(data?.status).not.toBe('archived');
  });

  it('the database refuses a self-referential supersession', async () => {
    const target = world.requirementIds[0]!;
    const { error } = await adminClient()
      .from('requirements')
      .update({ superseded_by_requirement_id: target })
      .eq('id', target);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/no_self_supersede|check/i);
  });

  it('the database refuses a cross-case supersession pointer', async () => {
    const other = await buildOrganizationWorld({
      name: 'Notaría Other Supersede',
      industry: 'notary',
      clientEmail: `sup-other-${randomUUID()}@example.test`,
    });
    const foreignRequirement = other.requirementIds[0]!;

    const { error } = await adminClient()
      .from('requirements')
      .update({ superseded_by_requirement_id: foreignRequirement })
      .eq('id', world.requirementIds[2]!);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/foreign key|violates/i);
  });
});
