import { describe, expect, it, vi } from 'vitest';
import { addStaffMember, createOrganizationWithOwner } from '../helpers/clients';
import { saveBlueprint } from '@/application/save-blueprint';
import { deleteBlueprint } from '@/application/delete-blueprint';
import { UseCaseError } from '@/application/errors';

describe('saveBlueprint', () => {
  it('creates a Blueprint and returns its id', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Create', 'notary');

    const result = await saveBlueprint(
      owner.client,
      {
        organizationId,
        name: 'Compraventa',
        stages: [],
        participantTemplates: [],
        requirements: [],
      },
      owner.userId,
    );

    expect(result.blueprintId).toEqual(expect.any(String));
    const { data: row } = await owner.client.from('blueprints').select('name').eq('id', result.blueprintId).single();
    expect(row?.name).toBe('Compraventa');
  });

  it('fully replaces children on edit — an old stage absent from the new payload is gone', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Edit', 'notary');

    const created = await saveBlueprint(
      owner.client,
      { organizationId, name: 'V1', stages: [{ name: 'Old stage', position: 0 }], participantTemplates: [], requirements: [] },
      owner.userId,
    );

    await saveBlueprint(
      owner.client,
      { organizationId, blueprintId: created.blueprintId, name: 'V2', stages: [{ name: 'New stage', position: 0 }], participantTemplates: [], requirements: [] },
      owner.userId,
    );

    const { data: stages } = await owner.client.from('blueprint_stages').select('name').eq('blueprint_id', created.blueprintId);
    expect(stages).toEqual([{ name: 'New stage' }]);
  });

  it('maps duplicate_stage_position to a validation UseCaseError', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Dup Stage', 'notary');

    await expect(
      saveBlueprint(
        owner.client,
        {
          organizationId, name: 'X',
          stages: [{ name: 'A', position: 0 }, { name: 'B', position: 0 }],
          participantTemplates: [], requirements: [],
        },
        owner.userId,
      ),
    ).rejects.toMatchObject({ reason: 'validation', message: 'No puede haber dos etapas con la misma posición.' });
  });

  it('maps blueprint_not_found for a cross-org blueprintId', async () => {
    // NOTE: the brief's original version of this test created a *third*, unrelated organization
    // and used that owner's client to create the "in orgA" blueprint. That owner has no membership
    // in orgA, so save_blueprint would reject the call outright (not_owner) rather than actually
    // creating a blueprint scoped to orgA — it didn't test what its name claims. Fixed here to use
    // orgA's own owner to create the blueprint, then attempt the cross-org edit as ownerB.
    const { organizationId: orgA, owner: ownerA } = await createOrganizationWithOwner('Notaría Save Cross A', 'notary');
    const { organizationId: orgB, owner: ownerB } = await createOrganizationWithOwner('Notaría Save Cross B', 'notary');
    const createdInA = await saveBlueprint(
      ownerA.client,
      { organizationId: orgA, name: 'A', stages: [], participantTemplates: [], requirements: [] },
      ownerA.userId,
    );

    await expect(
      saveBlueprint(ownerB.client, { organizationId: orgB, blueprintId: createdInA.blueprintId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, ownerB.userId),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('rejects a non-owner with forbidden via the RPC not_owner code', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save NotOwner', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    await expect(
      saveBlueprint(staff.client, { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, staff.userId),
    ).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('maps every closed RPC validation code to the correct UseCaseError message', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save All Codes', 'notary');

    // Every one of these five payloads would actually be caught by saveBlueprint's own local
    // validateBlueprintStructure() pass *before* client.rpc is ever called (it runs the identical
    // structural checks as a client-side mirror of the RPC's checks, and for one of these codes —
    // unknown_participant_role_key vs. the local orphaned_role_key — the message text genuinely
    // differs between the two layers). So a plain call through the public saveBlueprint contract
    // can never actually exercise the RPC's own code-to-message mapping for these five closed
    // codes; the local layer always wins the race. To deterministically test the RPC_VALIDATION_
    // MESSAGES mapping table itself (the thing this test is actually named for), we use a valid
    // payload (passes local validation) and spy on client.rpc to simulate the RPC surfacing each
    // closed code — the same technique the "unrecognized RPC error" test below already uses and
    // justifies.
    const codes: { code: string; expectedMessage: string }[] = [
      { code: 'duplicate_participant_role_key', expectedMessage: 'Cada rol de participante debe tener un identificador único.' },
      { code: 'duplicate_participant_position', expectedMessage: 'No puede haber dos roles de participante con la misma posición.' },
      { code: 'unknown_participant_role_key', expectedMessage: 'Un requisito hace referencia a un rol de participante inexistente.' },
      { code: 'unknown_stage_position', expectedMessage: 'Un requisito hace referencia a una etapa inexistente.' },
      { code: 'duplicate_requirement_key', expectedMessage: 'Cada requisito debe tener una clave única dentro de su alcance.' },
    ];

    for (const c of codes) {
      const rpcSpy = vi.spyOn(owner.client, 'rpc').mockReturnValueOnce(
        Promise.resolve({ data: null, error: { message: c.code, code: 'P0001' } }) as never,
      );
      await expect(
        saveBlueprint(
          owner.client,
          { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] },
          owner.userId,
        ),
        c.code,
      ).rejects.toMatchObject({ reason: 'validation', message: c.expectedMessage });
      rpcSpy.mockRestore();
    }
  });

  it('rethrows an unrecognized RPC error as unexpected rather than downgrading to forbidden', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Unexpected', 'notary');

    // Forcing a genuine unrecognized Postgres error would require bypassing the RPC's own
    // preflight checks entirely — not reachable through the public save_blueprint contract. This
    // spies on the one integration point (client.rpc) to simulate that scenario deterministically:
    // an error whose message is not a key in RPC_VALIDATION_MESSAGES and not 'blueprint_not_found'
    // or 'not_owner' must propagate as-is, not be silently reclassified as 'forbidden'.
    const rpcSpy = vi.spyOn(owner.client, 'rpc').mockReturnValueOnce(
      Promise.resolve({ data: null, error: { message: 'some_never_before_seen_code', code: 'P0001' } }) as never,
    );

    await expect(
      saveBlueprint(owner.client, { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, owner.userId),
    ).rejects.not.toMatchObject({ reason: 'forbidden' });

    rpcSpy.mockRestore();
  });
});

describe('deleteBlueprint', () => {
  it('deletes an existing Blueprint', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Delete OK', 'notary');
    const created = await saveBlueprint(owner.client, { organizationId, name: 'To delete', stages: [], participantTemplates: [], requirements: [] }, owner.userId);

    const result = await deleteBlueprint(owner.client, { organizationId, blueprintId: created.blueprintId }, owner.userId);
    expect(result.blueprintId).toBe(created.blueprintId);

    const { data } = await owner.client.from('blueprints').select('id').eq('id', created.blueprintId).maybeSingle();
    expect(data).toBeNull();
  });

  it('returns not_found for an already-deleted id', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Delete Twice', 'notary');
    const created = await saveBlueprint(owner.client, { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, owner.userId);
    await deleteBlueprint(owner.client, { organizationId, blueprintId: created.blueprintId }, owner.userId);

    await expect(deleteBlueprint(owner.client, { organizationId, blueprintId: created.blueprintId }, owner.userId))
      .rejects.toMatchObject({ reason: 'not_found' });
  });
});

void UseCaseError; // referenced for type-only import checks in this file's future extensions
