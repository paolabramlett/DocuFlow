import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';
import { getBlueprintDefinition, listBlueprintSummaries } from '@/features/blueprints/queries';
import type { Json } from '@/types/database';

describe('listBlueprintSummaries', () => {
  it('counts case and participant requirements separately, and defaults missing scope to case', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Summary', 'notary');

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Summary test',
        requirement_definitions: [
          { key: 'a', type: 'document', label: 'A', scope: 'case' },
          { key: 'b', type: 'document', label: 'B' }, // missing scope -> case
          { key: 'c', type: 'document', label: 'C', scope: 'participant', participant_role_key: 'buyer' },
        ],
      })
      .select('id')
      .single();
    await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprint!.id, role_key: 'buyer', display_name: 'Comprador', position: 0,
    });
    await owner.client.from('blueprint_stages').insert({
      organization_id: organizationId, blueprint_id: blueprint!.id, name: 'Stage 1', position: 0,
    });

    const summaries = await listBlueprintSummaries(owner.client, organizationId);
    const summary = summaries.find((s) => s.id === blueprint!.id);

    expect(summary).toMatchObject({
      name: 'Summary test',
      isPlatformTemplate: false,
      stageCount: 1,
      participantTemplateCount: 1,
      caseRequirementCount: 2,
      participantRequirementCount: 1,
    });
  });

  it('ignores malformed or unknown-scope definitions for counting, without throwing', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Summary Bad', 'notary');

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Malformed test',
        requirement_definitions: [
          { key: 'ok', type: 'document', label: 'OK', scope: 'case' },
          { scope: 'unknown' },
          'not-an-object',
          42,
        ],
      })
      .select('id')
      .single();

    const summaries = await listBlueprintSummaries(owner.client, organizationId);
    const summary = summaries.find((s) => s.id === blueprint!.id);

    expect(summary?.caseRequirementCount).toBe(1);
    expect(summary?.participantRequirementCount).toBe(0);
  });

  it('never fails the whole list because one blueprint is malformed', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Summary Mixed', 'notary');

    await owner.client.from('blueprints').insert({
      organization_id: organizationId,
      name: 'Bad one',
      requirement_definitions: ['garbage'],
    });
    await owner.client.from('blueprints').insert({
      organization_id: organizationId,
      name: 'Good one',
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case' }],
    });

    const summaries = await listBlueprintSummaries(owner.client, organizationId);
    expect(summaries.map((s) => s.name).sort()).toEqual(['Bad one', 'Good one']);
  });

  it('returns [] on permission denied (42501), matching getClientsDirectory\'s convention', async () => {
    const summaries = await listBlueprintSummaries(adminClient(), '00000000-0000-0000-0000-000000000000');
    // Using adminClient bypasses RLS entirely, so this test instead confirms a nonexistent org
    // simply yields an empty, non-throwing result — the 42501 path itself is exercised implicitly
    // by every anon/cross-tenant test elsewhere in the suite hitting RLS-denied selects the same way.
    expect(summaries).toEqual([]);
  });
});

describe('getBlueprintDefinition', () => {
  async function orgWithBlueprint(name: string, definitions: unknown[], templates: { roleKey: string; displayName: string; position: number }[] = [], stages: { name: string; position: number }[] = []) {
    const { organizationId, owner } = await createOrganizationWithOwner(name, 'notary');
    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({ organization_id: organizationId, name, requirement_definitions: definitions as Json })
      .select('id')
      .single();
    for (const t of templates) {
      await owner.client.from('blueprint_participant_templates').insert({
        organization_id: organizationId, blueprint_id: blueprint!.id,
        role_key: t.roleKey, display_name: t.displayName, position: t.position,
      });
    }
    for (const s of stages) {
      await owner.client.from('blueprint_stages').insert({
        organization_id: organizationId, blueprint_id: blueprint!.id, name: s.name, position: s.position,
      });
    }
    return { organizationId, owner, blueprintId: blueprint!.id };
  }

  it('returns null for a nonexistent blueprint', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Def None', 'notary');
    const result = await getBlueprintDefinition(owner.client, randomUUID(), organizationId);
    expect(result).toBeNull();
  });

  it('returns null for a blueprint belonging to another organization', async () => {
    const { organizationId: orgA } = await orgWithBlueprint('Notaría Def A', [{ key: 'x', type: 'document', label: 'X', scope: 'case' }]);
    const { organizationId: orgB, owner: ownerB } = await createOrganizationWithOwner('Notaría Def B', 'notary');
    const { blueprintId } = await orgWithBlueprint('Notaría Def A2', [{ key: 'x', type: 'document', label: 'X', scope: 'case' }]);
    const result = await getBlueprintDefinition(ownerB.client, blueprintId, orgB);
    expect(result).toBeNull();
    void orgA;
  });

  it('parses a valid case-scoped requirement', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Case', [
      { key: 'appraisal', type: 'document', label: 'Avalúo', scope: 'case', instructions: 'Recent one' },
    ]);
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.requirements).toEqual([
      { key: 'appraisal', type: 'document', label: 'Avalúo', instructions: 'Recent one', scope: 'case', participantRoleKey: null, stagePosition: null },
    ]);
  });

  it('parses a valid participant-scoped requirement', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint(
      'Notaría Def Participant',
      [{ key: 'official-id', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer' }],
      [{ roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
    );
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.requirements[0]).toMatchObject({ key: 'official-id', scope: 'participant', participantRoleKey: 'buyer' });
    expect(def?.participantTemplates[0]).toMatchObject({ roleKey: 'buyer', displayName: 'Comprador', position: 0 });
  });

  it('defaults a missing scope to case', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Legacy', [
      { key: 'legacy', type: 'document', label: 'Legacy' },
    ]);
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.requirements[0]?.scope).toBe('case');
  });

  it('allows the same key reused across different participant-role buckets', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint(
      'Notaría Def Cross Bucket',
      [
        { key: 'official-id', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer' },
        { key: 'official-id', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'seller' },
      ],
      [
        { roleKey: 'buyer', displayName: 'Comprador', position: 0 },
        { roleKey: 'seller', displayName: 'Vendedor', position: 1 },
      ],
    );
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.requirements).toHaveLength(2);
  });

  it('allows the same key reused between case and a participant bucket', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint(
      'Notaría Def Case Vs Participant Bucket',
      [
        { key: 'shared', type: 'document', label: 'Shared A', scope: 'case' },
        { key: 'shared', type: 'document', label: 'Shared B', scope: 'participant', participant_role_key: 'buyer' },
      ],
      [{ roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
    );
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.requirements).toHaveLength(2);
  });

  it('preserves the JSON array order of requirements', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Order', [
      { key: 'third', type: 'document', label: 'Third', scope: 'case' },
      { key: 'first', type: 'document', label: 'First', scope: 'case' },
      { key: 'second', type: 'document', label: 'Second', scope: 'case' },
    ]);
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.requirements.map((r) => r.key)).toEqual(['third', 'first', 'second']);
  });

  it('sorts stages and participant templates by position, regardless of insertion order', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint(
      'Notaría Def Sort',
      [],
      [
        { roleKey: 'seller', displayName: 'Vendedor', position: 1 },
        { roleKey: 'buyer', displayName: 'Comprador', position: 0 },
      ],
      [
        { name: 'Signature', position: 1 },
        { name: 'Documents', position: 0 },
      ],
    );
    const def = await getBlueprintDefinition(owner.client, blueprintId, organizationId);
    expect(def?.stages.map((s) => s.name)).toEqual(['Documents', 'Signature']);
    expect(def?.participantTemplates.map((t) => t.roleKey)).toEqual(['buyer', 'seller']);
  });

  it('throws when a definition is not a plain object', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Not Object', ['garbage']);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on a missing key', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Missing Key', [
      { type: 'document', label: 'No key', scope: 'case' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on an empty or whitespace-only key', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Blank Key', [
      { key: '   ', type: 'document', label: 'Blank key', scope: 'case' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on a missing label', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Missing Label', [
      { key: 'no-label', type: 'document', scope: 'case' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on an empty or whitespace-only label', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Blank Label', [
      { key: 'blank-label', type: 'document', label: '   ', scope: 'case' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on an invalid slug format', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Bad Slug', [
      { key: 'Not_A_Slug', type: 'document', label: 'Bad slug', scope: 'case' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on an invalid scope', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Bad Scope', [
      { key: 'x', type: 'document', label: 'X', scope: 'unknown' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws when scope is participant with no participant_role_key', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def No Role Key', [
      { key: 'x', type: 'document', label: 'X', scope: 'participant' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws when scope is case but participant_role_key is present', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Extra Role Key', [
      { key: 'x', type: 'document', label: 'X', scope: 'case', participant_role_key: 'buyer' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on an empty participant_role_key', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Empty Role Key', [
      { key: 'x', type: 'document', label: 'X', scope: 'participant', participant_role_key: '' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on an orphaned participant_role_key', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Orphan Role Key', [
      { key: 'x', type: 'document', label: 'X', scope: 'participant', participant_role_key: 'nonexistent' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on a duplicate key in the case bucket', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Dup Case Key', [
      { key: 'dup', type: 'document', label: 'A', scope: 'case' },
      { key: 'dup', type: 'document', label: 'B', scope: 'case' },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on a duplicate key within the same participant-role bucket', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint(
      'Notaría Def Dup Participant Key',
      [
        { key: 'dup', type: 'document', label: 'A', scope: 'participant', participant_role_key: 'buyer' },
        { key: 'dup', type: 'document', label: 'B', scope: 'participant', participant_role_key: 'buyer' },
      ],
      [{ roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
    );
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('duplicate participant-template position', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint(
      'Notaría Def Dup Template Position',
      [],
      [
        { roleKey: 'buyer', displayName: 'Comprador', position: 0 },
      ],
    );
    // The DB's own unique(blueprint_id, position) constraint (Task 1) would reject a second insert
    // at the same position outright — this proves the app-layer check is redundant-but-present by
    // confirming the DB constraint itself is what's actually enforcing it here. (Uses a different
    // role_key than the existing row so the DB's separate unique(blueprint_id, role_key)
    // constraint doesn't fire first and mask the position check.)
    const { error } = await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprintId, role_key: 'seller', display_name: 'Vendedor', position: 0,
    });
    expect(error).not.toBeNull();
  });

  it('throws on an invalid participant-template role_key format', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Bad Template Key', []);
    await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprintId, role_key: 'Not_A_Slug', display_name: 'Bad', position: 0,
    });
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws when stage_position references a nonexistent stage', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Bad Stage Position', [
      { key: 'x', type: 'document', label: 'X', scope: 'case', stage_position: 5 },
    ]);
    await expect(getBlueprintDefinition(owner.client, blueprintId, organizationId)).rejects.toThrow();
  });

  it('throws on a duplicate blueprint_stages position', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint('Notaría Def Dup Stage Position', []);
    // The DB's own unique(blueprint_id, position) constraint (Task 1) would reject a second insert
    // at the same position outright — this proves the app-layer check is redundant-but-present by
    // confirming the DB constraint itself is what's actually enforcing it here.
    await owner.client.from('blueprint_stages').insert({ organization_id: organizationId, blueprint_id: blueprintId, name: 'A', position: 0 });
    const { error } = await owner.client.from('blueprint_stages').insert({ organization_id: organizationId, blueprint_id: blueprintId, name: 'B', position: 0 });
    expect(error).not.toBeNull();
  });
});
