import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrganizationWithOwner, addStaffMember } from '../helpers/clients';
import {
  createCaseWithParticipants,
  createCaseWithParticipantsSchema,
} from '@/application/create-case-with-participants';
import * as blueprintQueries from '@/features/blueprints/queries';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCaseWithParticipantsSchema', () => {
  const base = { organizationId: randomUUID(), title: 'Test case' };

  it('accepts a blueprint participant with participantTemplateRoleKey and requirementKeys', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      blueprintId: randomUUID(),
      participants: [{
        source: 'blueprint', participantTemplateRoleKey: 'buyer',
        roleLabel: 'Comprador', fullName: 'Ana', email: 'ana@example.test',
        requirementKeys: ['official-id'],
      }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a manual participant with freeform requirements', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      participants: [{
        source: 'manual', roleLabel: 'Testigo', fullName: 'Ana', email: 'ana@example.test',
        requirements: ['Cualquier cosa'],
      }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a manual participant carrying blueprint-only fields', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      participants: [{
        source: 'manual', roleLabel: 'Testigo', fullName: 'Ana', email: 'ana@example.test',
        requirements: ['x'], participantTemplateRoleKey: 'buyer',
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a blueprint participant using the manual shape (requirements instead of requirementKeys)', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      blueprintId: randomUUID(),
      participants: [{
        source: 'blueprint', participantTemplateRoleKey: 'buyer',
        roleLabel: 'Comprador', fullName: 'Ana', email: 'ana@example.test',
        requirements: ['x'],
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate requirementKeys', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      blueprintId: randomUUID(),
      participants: [{
        source: 'blueprint', participantTemplateRoleKey: 'buyer',
        roleLabel: 'Comprador', fullName: 'Ana', email: 'ana@example.test',
        requirementKeys: ['official-id', 'official-id'],
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty requirementKeys entry', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      blueprintId: randomUUID(),
      participants: [{
        source: 'blueprint', participantTemplateRoleKey: 'buyer',
        roleLabel: 'Comprador', fullName: 'Ana', email: 'ana@example.test',
        requirementKeys: [''],
      }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with no source', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      participants: [{ roleLabel: 'Testigo', fullName: 'Ana', email: 'ana@example.test', requirements: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with an unknown source', () => {
    const result = createCaseWithParticipantsSchema.safeParse({
      ...base,
      participants: [{ source: 'weird', roleLabel: 'Testigo', fullName: 'Ana', email: 'ana@example.test' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('createCaseWithParticipants orchestration', () => {
  async function orgWithBlueprint() {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Orchestration', 'notary');
    const staff = await addStaffMember(owner, organizationId);
    const { data: blueprint } = await owner.client
      .from('blueprints')
      .insert({
        organization_id: organizationId,
        name: 'Compraventa test',
        requirement_definitions: [
          { key: 'official-id', type: 'document', label: 'INE', scope: 'participant', participant_role_key: 'buyer' },
          { key: 'proof-of-address', type: 'document', label: 'Comprobante de domicilio', scope: 'participant', participant_role_key: 'buyer' },
          { key: 'appraisal', type: 'document', label: 'Avalúo', scope: 'case' },
        ],
      })
      .select('id')
      .single();
    await owner.client.from('blueprint_participant_templates').insert([
      { organization_id: organizationId, blueprint_id: blueprint!.id, role_key: 'buyer', display_name: 'Comprador', position: 0 },
      { organization_id: organizationId, blueprint_id: blueprint!.id, role_key: 'seller', display_name: 'Vendedor', position: 1 },
    ]);
    return { organizationId, owner, staff, blueprintId: blueprint!.id };
  }

  it('fetches the blueprint definition exactly once per call, even with multiple participants', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    // Real behavior is preserved (no mockImplementation) — this only observes call count.
    const spy = vi.spyOn(blueprintQueries, 'getBlueprintDefinition');

    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Two blueprint participants', blueprintId,
      participants: [
        { source: 'blueprint', participantTemplateRoleKey: 'buyer', roleLabel: 'Comprador', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: ['official-id'] },
        { source: 'blueprint', participantTemplateRoleKey: 'seller', roleLabel: 'Vendedor', fullName: 'Luis', email: `luis-${randomUUID()}@example.test`, requirementKeys: [] },
      ],
      sendInvitations: false,
    }, owner.userId);

    expect(result.participants).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('rejects a blueprint participant when blueprintId is missing', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría No Blueprint Id', 'notary');
    await expect(
      createCaseWithParticipants(owner.client, {
        organizationId, title: 'Missing blueprintId',
        participants: [{ source: 'blueprint', participantTemplateRoleKey: 'buyer', roleLabel: 'Comprador', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: [] }],
        sendInvitations: false,
      }, owner.userId),
    ).rejects.toMatchObject({ reason: 'validation' });
  });

  it('rejects an unknown role key with a validation error', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    await expect(
      createCaseWithParticipants(owner.client, {
        organizationId, title: 'Unknown role key', blueprintId,
        participants: [{ source: 'blueprint', participantTemplateRoleKey: 'nonexistent', roleLabel: 'X', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: [] }],
        sendInvitations: false,
      }, owner.userId),
    ).rejects.toMatchObject({ reason: 'validation' });
  });

  it('rejects a crafted/foreign blueprintId even with only manual participants', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Crafted Blueprint', 'notary');
    await expect(
      createCaseWithParticipants(owner.client, {
        organizationId, title: 'Crafted blueprintId', blueprintId: randomUUID(),
        participants: [{ source: 'manual', roleLabel: 'Testigo', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirements: [] }],
        sendInvitations: false,
      }, owner.userId),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('creates requirements only for selected allowed keys, omitting deselected ones', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Partial selection', blueprintId,
      participants: [{ source: 'blueprint', participantTemplateRoleKey: 'buyer', roleLabel: 'Comprador', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: ['official-id'] }],
      sendInvitations: false,
    }, owner.userId);

    const { data: requirements } = await owner.client
      .from('requirements')
      .select('label')
      .eq('case_id', result.caseId)
      .eq('participant_id', result.participants[0]!.id);

    expect(requirements?.map((r) => r.label)).toEqual(['INE']);
  });

  it('filters out an injected unknown requirement key without failing the request', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Injected key', blueprintId,
      participants: [{ source: 'blueprint', participantTemplateRoleKey: 'buyer', roleLabel: 'Comprador', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: ['official-id', 'not-a-real-key'] }],
      sendInvitations: false,
    }, owner.userId);

    const { data: requirements } = await owner.client
      .from('requirements')
      .select('label')
      .eq('case_id', result.caseId)
      .eq('participant_id', result.participants[0]!.id);

    expect(requirements?.map((r) => r.label)).toEqual(['INE']);
  });

  it('persists the blueprint\'s own canonical label, never client-supplied text', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Canonical label', blueprintId,
      participants: [{ source: 'blueprint', participantTemplateRoleKey: 'buyer', roleLabel: 'Comprador', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: ['official-id'] }],
      sendInvitations: false,
    }, owner.userId);

    // Filtered to this participant specifically: the blueprint's case-scoped 'appraisal'
    // definition also clones onto the case-level checklist (participant_id null) via the RPC,
    // so an unfiltered select on case_id alone would not deterministically return this
    // participant's row first.
    const { data: requirements } = await owner.client
      .from('requirements')
      .select('label')
      .eq('case_id', result.caseId)
      .eq('participant_id', result.participants[0]!.id);
    expect(requirements?.map((r) => r.label)).toEqual(['INE']); // the blueprint's label, not "official-id"
  });

  it('filters out a key that exists only under a different role', async () => {
    // orgWithBlueprint already defines both buyer and seller roles; 'official-id' is only tagged
    // for buyer, so requesting it as seller must be filtered, not thrown.
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Wrong role bucket', blueprintId,
      participants: [{ source: 'blueprint', participantTemplateRoleKey: 'seller', roleLabel: 'Vendedor', fullName: 'Luis', email: `luis-${randomUUID()}@example.test`, requirementKeys: ['official-id'] }],
      sendInvitations: false,
    }, owner.userId);

    const { data: requirements } = await owner.client
      .from('requirements')
      .select('label')
      .eq('case_id', result.caseId)
      .eq('participant_id', result.participants[0]!.id);
    expect(requirements).toEqual([]); // 'official-id' belongs to buyer, not seller — filtered, not thrown
  });

  it('leaves manual participants unrestricted with no blueprint', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Manual No Blueprint', 'notary');
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Manual only',
      participants: [{ source: 'manual', roleLabel: 'Testigo', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirements: ['Anything at all'] }],
      sendInvitations: false,
    }, owner.userId);

    const { data: requirements } = await owner.client
      .from('requirements')
      .select('label')
      .eq('case_id', result.caseId)
      .eq('participant_id', result.participants[0]!.id);
    expect(requirements?.map((r) => r.label)).toEqual(['Anything at all']);
  });

  it('leaves manual participants unrestricted alongside an active blueprint', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Manual with blueprint', blueprintId,
      participants: [{ source: 'manual', roleLabel: 'Testigo', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirements: ['Not in the blueprint at all'] }],
      sendInvitations: false,
    }, owner.userId);

    const { data: requirements } = await owner.client
      .from('requirements')
      .select('label')
      .eq('case_id', result.caseId)
      .eq('participant_id', result.participants[0]!.id);
    expect(requirements?.map((r) => r.label)).toEqual(['Not in the blueprint at all']);
  });

  it('creates one blueprint participant and one manual participant correctly in the same case', async () => {
    const { organizationId, owner, blueprintId } = await orgWithBlueprint();
    const result = await createCaseWithParticipants(owner.client, {
      organizationId, title: 'Mixed', blueprintId,
      participants: [
        { source: 'blueprint', participantTemplateRoleKey: 'buyer', roleLabel: 'Comprador', fullName: 'Ana', email: `ana-${randomUUID()}@example.test`, requirementKeys: ['official-id'] },
        { source: 'manual', roleLabel: 'Testigo', fullName: 'Luis', email: `luis-${randomUUID()}@example.test`, requirements: ['Carta poder'] },
      ],
      sendInvitations: false,
    }, owner.userId);

    expect(result.participants).toHaveLength(2);
    const buyer = result.participants.find((p) => p.role === 'Comprador')!;
    const witness = result.participants.find((p) => p.role === 'Testigo')!;

    const { data: buyerReqs } = await owner.client.from('requirements').select('label').eq('participant_id', buyer.id);
    const { data: witnessReqs } = await owner.client.from('requirements').select('label').eq('participant_id', witness.id);
    expect(buyerReqs?.map((r) => r.label)).toEqual(['INE']);
    expect(witnessReqs?.map((r) => r.label)).toEqual(['Carta poder']);
  });
});
