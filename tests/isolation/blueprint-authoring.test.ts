// tests/isolation/blueprint-authoring.test.ts
import { describe, expect, it } from 'vitest';
import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';

async function callSaveBlueprint(
  client: ReturnType<typeof adminClient>,
  args: {
    target_organization_id: string;
    target_blueprint_id?: string | null;
    blueprint_name?: string | null;
    blueprint_description?: string | null;
    stages?: unknown;
    participant_templates?: unknown;
    requirement_definitions?: unknown;
  },
) {
  return client.rpc('save_blueprint', {
    target_organization_id: args.target_organization_id,
    target_blueprint_id: args.target_blueprint_id ?? null,
    blueprint_name: args.blueprint_name ?? 'Test Blueprint',
    blueprint_description: args.blueprint_description ?? null,
    stages: (args.stages ?? []) as never,
    participant_templates: (args.participant_templates ?? []) as never,
    requirement_definitions: (args.requirement_definitions ?? []) as never,
  });
}

describe('save_blueprint: ownership', () => {
  it('rejects a non-owner staff member with not_owner', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Owner', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    const { error } = await callSaveBlueprint(staff.client, { target_organization_id: organizationId });

    expect(error?.message).toBe('not_owner');
  });

  it('allows the owner to create a Blueprint', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Owner OK', 'notary');

    const { data, error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      blueprint_name: 'Compraventa RPC',
    });

    expect(error).toBeNull();
    expect(data).toEqual(expect.any(String));
  });
});

describe('save_blueprint: malformed payloads', () => {
  it('rejects stages as an object instead of an array', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Stages Object', 'notary');
    const { error } = await callSaveBlueprint(owner.client, { target_organization_id: organizationId, stages: {} });
    expect(error?.message).toBe('invalid_stages_payload');
  });

  it('rejects a participant template missing role_key entirely', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Missing RoleKey', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      participant_templates: [{ display_name: 'Comprador', position: 0 }],
    });
    expect(error?.message).toBe('invalid_participant_template_shape');
  });

  it('rejects a requirement missing scope', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Missing Scope', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects a non-numeric stage_position string before attempting any cast', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Bad StagePos', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case', stage_position: 'abc' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects a stage name over 200 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Stage Name', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      stages: [{ name: 'x'.repeat(201), position: 0 }],
    });
    expect(error?.message).toBe('invalid_stage_shape');
  });

  it('rejects a role_key over 100 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long RoleKey', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      participant_templates: [{ role_key: 'a'.repeat(101), display_name: 'Comprador', position: 0 }],
    });
    expect(error?.message).toBe('invalid_participant_template_shape');
  });

  it('rejects a requirement label over 300 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Label', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'y'.repeat(301), scope: 'case' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects a requirement type over 100 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Type', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'z'.repeat(101), label: 'X', scope: 'case' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects instructions over 2000 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Instructions', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case', instructions: 'a'.repeat(2001) }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('treats an explicit JSON null participant_role_key under scope case the same as an absent key', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Null RoleKey', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case', participant_role_key: null }],
    });
    expect(error).toBeNull();
  });
});

describe('save_blueprint: atomicity', () => {
  it('leaves existing rows unchanged when the payload fails preflight validation', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Atomicity', 'notary');
    const { data: blueprintId } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      blueprint_name: 'Original name',
      stages: [{ name: 'Stage A', position: 0 }],
    });

    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      target_blueprint_id: blueprintId,
      blueprint_name: 'Should not stick',
      stages: [
        { name: 'Dup A', position: 0 },
        { name: 'Dup B', position: 0 },
      ],
    });
    expect(error?.message).toBe('duplicate_stage_position');

    const { data: row } = await owner.client.from('blueprints').select('name').eq('id', blueprintId!).single();
    expect(row?.name).toBe('Original name');
    const { data: stages } = await owner.client.from('blueprint_stages').select('name').eq('blueprint_id', blueprintId!);
    expect(stages).toEqual([{ name: 'Stage A' }]);
  });
});

describe('save_blueprint: concurrency', () => {
  it('serializes two concurrent edits to the same Blueprint via the FOR UPDATE lock', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Concurrency', 'notary');
    const { data: blueprintId } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      blueprint_name: 'Concurrent base',
    });

    const [first, second] = await Promise.all([
      callSaveBlueprint(owner.client, {
        target_organization_id: organizationId,
        target_blueprint_id: blueprintId,
        blueprint_name: 'Writer A',
      }),
      callSaveBlueprint(owner.client, {
        target_organization_id: organizationId,
        target_blueprint_id: blueprintId,
        blueprint_name: 'Writer B',
      }),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const { data: row } = await owner.client.from('blueprints').select('name').eq('id', blueprintId!).single();
    expect(['Writer A', 'Writer B']).toContain(row?.name);
  });
});

describe('save_blueprint: constraint backstop', () => {
  it('rejects a raw duplicate-position insert into blueprint_participant_templates, independent of the RPC', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Constraint', 'notary');
    const { data: blueprintId } = await callSaveBlueprint(owner.client, { target_organization_id: organizationId });

    await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprintId!, role_key: 'buyer', display_name: 'Comprador', position: 0,
    });
    const { error } = await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprintId!, role_key: 'seller', display_name: 'Vendedor', position: 0,
    });

    expect(error).not.toBeNull();
  });
});

void adminClient; // referenced only for type inference of callSaveBlueprint's client parameter
