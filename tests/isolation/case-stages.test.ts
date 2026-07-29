import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createOrganizationWithOwner, addStaffMember, adminClient } from '../helpers/clients';

/**
 * Blueprint stages are deep-copied into case stages on clone, and requirement definitions carrying
 * a stage_position land in the matching cloned stage (case-stages spec).
 */
describe('case stages', () => {
  async function blueprintWithStages() {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    const { data: client } = await owner.client
      .from('clients')
      .insert({
        organization_id: organizationId,
        full_name: 'Client',
        email: `stage-${randomUUID()}@example.test`,
      })
      .select('id')
      .single();

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Staged intake',
        // Two requirements in stage 0, one in stage 1.
        requirement_definitions: [
          { key: 'id', type: 'document', label: 'ID', stage_position: 0 },
          { key: 'proof-of-address', type: 'document', label: 'Proof of address', stage_position: 0 },
          { key: 'signed-mandate', type: 'document', label: 'Signed mandate', stage_position: 1 },
        ],
      })
      .select('id')
      .single();

    await owner.client.from('blueprint_stages').insert([
      { organization_id: organizationId, blueprint_id: blueprint!.id, name: 'Documents', position: 0 },
      { organization_id: organizationId, blueprint_id: blueprint!.id, name: 'Signature', position: 1 },
    ]);

    return { organizationId, owner, staff, clientId: client!.id, blueprintId: blueprint!.id };
  }

  it('copies blueprint stages into the case and maps requirements to them', async () => {
    const { organizationId, staff, clientId, blueprintId } = await blueprintWithStages();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: clientId,
      case_title: 'Staged case',
      from_blueprint_id: blueprintId,
    });

    const { data: stages } = await staff.client
      .from('case_stages')
      .select('id, name, position')
      .eq('case_id', caseId as string)
      .order('position');
    expect(stages?.map((s) => s.name)).toEqual(['Documents', 'Signature']);

    const documentsStage = stages!.find((s) => s.position === 0)!;
    const signatureStage = stages!.find((s) => s.position === 1)!;

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('label, stage_id')
      .eq('case_id', caseId as string)
      .order('position');

    const byLabel = Object.fromEntries((requirements ?? []).map((r) => [r.label, r.stage_id]));
    expect(byLabel['ID']).toBe(documentsStage.id);
    expect(byLabel['Proof of address']).toBe(documentsStage.id);
    expect(byLabel['Signed mandate']).toBe(signatureStage.id);
  });

  it('leaves existing cases untouched when blueprint stages change', async () => {
    const { organizationId, owner, staff, clientId, blueprintId } = await blueprintWithStages();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: clientId,
      case_title: 'Frozen case',
      from_blueprint_id: blueprintId,
    });

    const before = await staff.client
      .from('case_stages')
      .select('name')
      .eq('case_id', caseId as string)
      .order('position');

    // Mutate and delete blueprint stages.
    await owner.client.from('blueprint_stages').delete().eq('blueprint_id', blueprintId);

    const after = await staff.client
      .from('case_stages')
      .select('name')
      .eq('case_id', caseId as string)
      .order('position');

    expect(after.data).toEqual(before.data);
  });

  it('keeps case stages tenant-isolated', async () => {
    const { organizationId, staff, clientId, blueprintId } = await blueprintWithStages();
    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: clientId,
      case_title: 'Isolated case',
      from_blueprint_id: blueprintId,
    });

    const other = await createOrganizationWithOwner('Otra Stages', 'notary');
    const { data } = await other.owner.client
      .from('case_stages')
      .select('id')
      .eq('case_id', caseId as string);
    expect(data).toEqual([]);

    // Sanity: the owning staff can see them.
    const { data: mine } = await adminClient()
      .from('case_stages')
      .select('id')
      .eq('case_id', caseId as string);
    expect(mine?.length).toBe(2);
  });
});

describe('create_case requirement scope filter', () => {
  it('clones a case-scoped definition onto the case-level checklist', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Scope Case', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: client } = await owner.client
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Client', email: `scope-case-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const clientId = client!.id;

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Scope test — case',
        requirement_definitions: [
          { key: 'appraisal', type: 'document', label: 'Avalúo', scope: 'case' },
        ],
      })
      .select('id')
      .single();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: clientId,
      case_title: 'Case-scope test',
      from_blueprint_id: blueprint!.id,
    });

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('label, participant_id')
      .eq('case_id', caseId as string);

    expect(requirements?.map((r) => r.label)).toEqual(['Avalúo']);
    expect(requirements?.[0]?.participant_id).toBeNull();
  });

  it('does not clone a participant-scoped definition onto the case-level checklist', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Scope Participant', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: client } = await owner.client
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Client', email: `scope-p-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Scope test — participant',
        requirement_definitions: [
          { key: 'official-id', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer' },
        ],
      })
      .select('id')
      .single();
    await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprint!.id, role_key: 'buyer', display_name: 'Comprador', position: 0,
    });

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Participant-scope test',
      from_blueprint_id: blueprint!.id,
    });

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('id')
      .eq('case_id', caseId as string);

    expect(requirements).toEqual([]);
  });

  it('treats a missing scope as case (backward compatible with pre-existing data)', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Scope Legacy', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: client } = await owner.client
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Client', email: `scope-legacy-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Scope test — legacy',
        requirement_definitions: [
          { key: 'legacy-item', type: 'document', label: 'Legacy item' }, // no scope key at all
        ],
      })
      .select('id')
      .single();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Legacy-scope test',
      from_blueprint_id: blueprint!.id,
    });

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('label')
      .eq('case_id', caseId as string);

    expect(requirements?.map((r) => r.label)).toEqual(['Legacy item']);
  });

  it('excludes an unknown/malformed scope from the case-level clone', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Scope Malformed', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: client } = await owner.client
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Client', email: `scope-bad-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Scope test — malformed',
        requirement_definitions: [
          { key: 'bad-scope-item', type: 'document', label: 'Bad scope item', scope: 'unknown' },
        ],
      })
      .select('id')
      .single();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Malformed-scope test',
      from_blueprint_id: blueprint!.id,
    });

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('id')
      .eq('case_id', caseId as string);

    expect(requirements).toEqual([]);
  });

  it('clones only the case-scoped subset from a blueprint mixing both scopes', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Scope Mixed', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: client } = await owner.client
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Client', email: `scope-mixed-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Scope test — mixed',
        requirement_definitions: [
          { key: 'appraisal', type: 'document', label: 'Avalúo', scope: 'case' },
          { key: 'official-id', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer' },
        ],
      })
      .select('id')
      .single();
    await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprint!.id, role_key: 'buyer', display_name: 'Comprador', position: 0,
    });

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Mixed-scope test',
      from_blueprint_id: blueprint!.id,
    });

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('label')
      .eq('case_id', caseId as string);

    expect(requirements?.map((r) => r.label)).toEqual(['Avalúo']);
  });

  it('leaves existing non-blueprint case creation unchanged', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Scope None', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: client } = await owner.client
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Client', email: `scope-none-${randomUUID()}@example.test` })
      .select('id')
      .single();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'No-blueprint test',
    });

    const { data: requirements } = await staff.client
      .from('requirements')
      .select('id')
      .eq('case_id', caseId as string);

    expect(requirements).toEqual([]);
  });
});
