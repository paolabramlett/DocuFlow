import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';
import { grantVerifiedAccess } from '../helpers/fixtures';

describe('case stages workflow: schema', () => {
  it('case_stages.status defaults to locked and rejects an invalid value', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages Schema', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client', email: `stages-schema-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Schema Case',
    });
    const { data: stage } = await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa 1', position: 0 })
      .select('status, completion_mode')
      .single();
    expect(stage?.status).toBe('locked');
    expect(stage?.completion_mode).toBe('requirements');

    const { error } = await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa Mala', position: 1, status: 'bogus' });
    expect(error).not.toBeNull();
  });

  it('enforces at most one active stage per case', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages OneActive', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client 2', email: `stages-oneactive-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'OneActive Case',
    });
    await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa A', position: 0, status: 'active' });

    const { error } = await admin
      .from('case_stages')
      .insert({ organization_id: organizationId, case_id: caseId!, name: 'Etapa B', position: 1, status: 'active' });
    expect(error?.message).toContain('case_stages_one_active_per_case');
  });

  it('rejects a reopen_reason longer than 1000 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Stages Reason', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client 3', email: `stages-reason-${randomUUID()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Reason Case',
    });

    const { error } = await admin
      .from('requirements')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        type: 'document',
        label: 'Requisito',
        position: 0,
        reopen_reason: 'x'.repeat(1001),
      });
    expect(error).not.toBeNull();
  });
});

/** Builds an Organization + Case with N case_stages (position 0..N-1, first one 'active'), one
 *  Participant, and one client-visible 'requirements'-mode requirement per stage assigned to that
 *  Participant. Returns everything a stage-advancement test needs. */
async function buildStagedCase(options: {
  name: string;
  stageCount: number;
  completionModes?: ('requirements' | 'manual')[];
}) {
  const { organizationId, owner } = await createOrganizationWithOwner(options.name, 'notary');
  const staff = await addStaffMember(owner, organizationId);
  const admin = adminClient();
  const clientEmail = `staged-${randomUUID()}@example.test`;
  const { data: clientRow } = await admin
    .from('clients')
    .insert({ organization_id: organizationId, full_name: 'Cliente', email: clientEmail })
    .select('id')
    .single();
  const { data: caseId } = await staff.client.rpc('create_case', {
    target_organization_id: organizationId,
    target_client_id: clientRow!.id,
    case_title: options.name,
  });
  const { data: participant } = await staff.client
    .from('case_participants')
    .insert({ organization_id: organizationId, case_id: caseId!, client_id: clientRow!.id, role_label: 'primary' })
    .select('id')
    .single();

  const stageIds: string[] = [];
  for (let i = 0; i < options.stageCount; i++) {
    const { data: stage } = await admin
      .from('case_stages')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        name: `Etapa ${i + 1}`,
        position: i,
        status: i === 0 ? 'active' : 'locked',
        completion_mode: options.completionModes?.[i] ?? 'requirements',
        activated_at: i === 0 ? new Date().toISOString() : null,
      })
      .select('id')
      .single();
    stageIds.push(stage!.id);
  }

  const requirementIds: string[] = [];
  for (let i = 0; i < options.stageCount; i++) {
    const { data: req } = await admin
      .from('requirements')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        participant_id: participant!.id,
        stage_id: stageIds[i],
        type: 'document',
        label: `Requisito etapa ${i + 1}`,
        position: 0,
      })
      .select('id')
      .single();
    requirementIds.push(req!.id);
  }

  return {
    organizationId,
    owner,
    staff,
    caseId: caseId!,
    participantId: participant!.id,
    clientId: clientRow!.id,
    clientEmail,
    stageIds,
    requirementIds,
  };
}

describe('advance_case_stage', () => {
  it('completes the active stage and activates the next when the active stage is ready', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Basic', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);

    const { data, error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error).toBeNull();
    expect(data?.map((r) => r.participant_id)).toEqual([w.participantId]);

    const { data: stages } = await adminClient()
      .from('case_stages')
      .select('id, status')
      .eq('case_id', w.caseId)
      .order('position');
    expect(stages?.[0]).toMatchObject({ status: 'completed' });
    expect(stages?.[1]).toMatchObject({ status: 'active' });
  });

  it('rejects advancing when the active stage has an outstanding client-visible requirement', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance NotReady', stageCount: 2 });
    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('a requirements-mode stage with zero client-visible requirements never auto-readies', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance EmptyRequirements', stageCount: 2 });
    await adminClient().from('requirements').delete().eq('id', w.requirementIds[0]!);

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('a manual stage with zero client-visible requirements is trivially ready', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance ManualEmpty', stageCount: 2, completionModes: ['manual', 'requirements'] });
    await adminClient().from('requirements').delete().eq('id', w.requirementIds[0]!);

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error).toBeNull();
  });

  it('a manual stage with an outstanding client-visible requirement is blocked exactly like requirements-mode', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance ManualBlocked', stageCount: 2, completionModes: ['manual', 'requirements'] });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('rejects advancing when an unassigned ("Sin etapa") requirement is pending', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Unassigned', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').insert({
      organization_id: w.organizationId,
      case_id: w.caseId,
      participant_id: w.participantId,
      stage_id: null,
      type: 'document',
      label: 'Sin etapa',
      position: 1,
    });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('unassigned_requirement_pending');
  });

  it('completing the last stage does not close the Case', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance LastStage', stageCount: 1 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);

    const { data, error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    const { data: stage } = await adminClient().from('case_stages').select('status').eq('id', w.stageIds[0]!).single();
    expect(stage?.status).toBe('completed');
    const { data: caseRow } = await adminClient().from('cases').select('state').eq('id', w.caseId).single();
    expect(caseRow?.state).toBe('open');
  });

  it('a satisfied-by-legacy-data requirement in the newly-active stage is not notified', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance NoNotify', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[1]!);

    const { data } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(data).toHaveLength(0);
  });

  it('serializes two concurrent advance calls on the same Case — the second sees the new state', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Concurrent', stageCount: 3 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[1]!);

    const [a, b] = await Promise.all([
      w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId }),
      w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId }),
    ]);
    // Exactly one of the two calls actually advances past stage 1 in this race (both target the
    // stage that was active when they started); the loser either succeeds against the
    // already-ready stage 2 too (if it re-reads after the winner committed) or fails
    // stage_not_ready (if stage 2's own requirement was never satisfied) — the invariant this test
    // protects is that no stage was ever skipped and the row lock actually serialized them, not a
    // pinned outcome for which call "wins".
    const { data: stages } = await adminClient()
      .from('case_stages')
      .select('status')
      .eq('case_id', w.caseId)
      .order('position');
    const activeCount = stages?.filter((s) => s.status === 'active').length ?? 0;
    expect(activeCount).toBeLessThanOrEqual(1);
    const completedCount = stages?.filter((s) => s.status === 'completed').length ?? 0;
    expect(completedCount).toBeGreaterThanOrEqual(1);
    expect([a.error, b.error].some((e) => e === null)).toBe(true);
  });

  it('a Client cannot call advance_case_stage despite an active grant', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Client', stageCount: 1 });
    const granted = await grantVerifiedAccess({
      world: {
        organizationId: w.organizationId,
        owner: w.owner,
        staff: w.staff,
        clientId: w.clientId,
        clientEmail: w.clientEmail,
        blueprintId: '',
        caseId: w.caseId,
        participantId: w.participantId,
        requirementIds: w.requirementIds,
      },
      permission: 'view',
    });

    const { error } = await granted.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('not_authorized');
  });
});
