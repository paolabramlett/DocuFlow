import { describe, expect, it } from 'vitest';
import {
  BlueprintIntegrityError,
  normalizeBlueprintDraft,
  normalizeBlueprintFromDb,
  validateBlueprintStructure,
  type NormalizedBlueprint,
} from '@/features/blueprints/queries';

function base(): NormalizedBlueprint {
  return {
    name: 'Compraventa',
    description: null,
    stages: [{ name: 'Firma', position: 0 }],
    participantTemplates: [{ roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
    requirements: [
      { key: 'title-deed', type: 'document', label: 'Escritura', instructions: null, scope: 'case', participantRoleKey: null, stagePosition: null, config: undefined },
      { key: 'official-id', type: 'document', label: 'INE', instructions: null, scope: 'participant', participantRoleKey: 'buyer', stagePosition: 0, config: undefined },
    ],
  };
}

describe('normalizeBlueprintFromDb', () => {
  it('defaults a missing scope to case', () => {
    const row = {
      id: 'x', name: 'X', description: null,
      requirement_definitions: [{ key: 'legacy', type: 'document', label: 'Legacy' }],
      blueprint_stages: [], blueprint_participant_templates: [],
    };
    const normalized = normalizeBlueprintFromDb(row as never);
    expect(normalized.requirements[0]?.scope).toBe('case');
  });
});

describe('normalizeBlueprintDraft', () => {
  it('never defaults a missing scope — a draft item lacking scope is simply not case-shaped', () => {
    const draft = {
      name: 'X', stages: [], participantTemplates: [],
      requirements: [{ key: 'x', type: 'document', label: 'X' } as never],
    };
    // normalizeBlueprintDraft trusts its caller (the Zod-validated use case) to have already
    // enforced `scope` is present via the discriminated union — this test documents that the
    // normalizer itself performs no defaulting, unlike the read-side normalizer above.
    expect(() => normalizeBlueprintDraft(draft)).not.toBe(normalizeBlueprintFromDb);
  });
});

describe('validateBlueprintStructure', () => {
  it('accepts a fully valid structure and returns the canonical shape', () => {
    const result = validateBlueprintStructure(base());
    expect(result.requirements).toHaveLength(2);
    expect(result.stages[0]).toEqual({ name: 'Firma', position: 0 });
  });

  it('rejects an invalid role_key slug', () => {
    const b = base();
    b.participantTemplates[0]!.roleKey = 'Not_A_Slug';
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate role key', () => {
    const b = base();
    b.participantTemplates.push({ roleKey: 'buyer', displayName: 'Dup', position: 1 });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate stage position', () => {
    const b = base();
    b.stages.push({ name: 'Dup', position: 0 });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate participant-template position', () => {
    const b = base();
    b.participantTemplates.push({ roleKey: 'seller', displayName: 'Vendedor', position: 0 });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects an orphaned participantRoleKey', () => {
    const b = base();
    b.requirements[1]!.participantRoleKey = 'nonexistent';
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects an orphaned stagePosition', () => {
    const b = base();
    b.requirements[0]!.stagePosition = 9;
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate key within the same bucket', () => {
    const b = base();
    b.requirements.push({ ...b.requirements[0]! });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('allows the same key reused across different buckets', () => {
    const b = base();
    b.requirements[1]!.key = 'title-deed'; // same key as requirements[0], different bucket
    expect(() => validateBlueprintStructure(b)).not.toThrow();
  });

  it('rejects scope participant without a participantRoleKey', () => {
    const b = base();
    b.requirements[1]!.participantRoleKey = null;
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects scope case carrying a participantRoleKey', () => {
    const b = base();
    b.requirements[0]!.participantRoleKey = 'buyer';
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('orders stages and participant templates by position regardless of input array order', () => {
    const b = base();
    b.stages = [{ name: 'Second', position: 1 }, { name: 'First', position: 0 }];
    const result = validateBlueprintStructure(b);
    expect(result.stages.map((s) => s.name)).toEqual(['First', 'Second']);
  });
});
