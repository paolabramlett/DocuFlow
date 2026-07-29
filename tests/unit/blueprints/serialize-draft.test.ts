import { describe, expect, it } from 'vitest';
import { serializeDraftToNormalizedBlueprint, type EditorDraft } from '@/app/blueprints/blueprint-editor';

function baseDraft(): EditorDraft {
  return {
    name: 'Compraventa',
    description: '',
    stages: [
      { draftId: 's1', name: 'Firma' },
      { draftId: 's2', name: 'Entrega' },
    ],
    participantTemplates: [
      { draftId: 'p1', roleKey: 'buyer', keyTouched: true, displayName: 'Comprador' },
    ],
    requirements: [
      { stageDraftId: 's1', participantRoleDraftId: null, key: 'title-deed', keyTouched: true, type: 'document', label: 'Escritura', scope: 'case' },
      { stageDraftId: null, participantRoleDraftId: 'p1', key: 'official-id', keyTouched: true, type: 'document', label: 'INE', scope: 'participant' },
    ],
  };
}

describe('serializeDraftToNormalizedBlueprint', () => {
  it('derives position and stagePosition/participantRoleKey from draftId references', () => {
    const normalized = serializeDraftToNormalizedBlueprint(baseDraft());
    expect(normalized.stages).toEqual([{ name: 'Firma', position: 0 }, { name: 'Entrega', position: 1 }]);
    expect(normalized.requirements[0]).toMatchObject({ scope: 'case', stagePosition: 0, participantRoleKey: null });
    expect(normalized.requirements[1]).toMatchObject({ scope: 'participant', participantRoleKey: 'buyer', stagePosition: null });
  });

  it('preserves stageDraftId associations when stages are reordered', () => {
    const draft = baseDraft();
    // Reorder: Entrega (s2) now comes first.
    draft.stages = [
      { draftId: 's2', name: 'Entrega' },
      { draftId: 's1', name: 'Firma' },
    ];
    const normalized = serializeDraftToNormalizedBlueprint(draft);
    // requirements[0] still references s1 ("Firma"), which is now at position 1.
    expect(normalized.requirements[0]?.stagePosition).toBe(1);
  });

  it('serializes a null stageDraftId as no stagePosition', () => {
    const draft = baseDraft();
    draft.requirements[0]!.stageDraftId = null;
    const normalized = serializeDraftToNormalizedBlueprint(draft);
    expect(normalized.requirements[0]?.stagePosition).toBeNull();
  });
});
