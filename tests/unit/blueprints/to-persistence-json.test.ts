import { describe, expect, it } from 'vitest';
import { toPersistenceJson } from '@/application/save-blueprint';
import type { ValidatedBlueprintStructure } from '@/features/blueprints/queries';

describe('toPersistenceJson', () => {
  it('converts camelCase field names to the snake_case shape the RPC and stored JSON expect', () => {
    const validated: ValidatedBlueprintStructure = {
      name: 'Compraventa',
      description: null,
      stages: [{ id: '', name: 'Firma', position: 0 }],
      participantTemplates: [{ id: '', roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
      requirements: [
        { key: 'official-id', type: 'document', label: 'INE', instructions: null, scope: 'participant', participantRoleKey: 'buyer', stagePosition: 0, config: undefined },
      ],
    };

    expect(toPersistenceJson(validated)).toEqual({
      stages: [{ name: 'Firma', position: 0 }],
      participantTemplates: [{ role_key: 'buyer', display_name: 'Comprador', position: 0 }],
      requirements: [
        { key: 'official-id', type: 'document', label: 'INE', instructions: null, scope: 'participant', participant_role_key: 'buyer', stage_position: 0, config: undefined },
      ],
    });
  });
});
