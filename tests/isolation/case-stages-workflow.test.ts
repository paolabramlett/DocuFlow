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

  it('a race on the same Case serializes: exactly one advance succeeds, the loser gets a stable error, no stage is skipped', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance Concurrent', stageCount: 3 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    // Deliberately leave w.requirementIds[1] (stage 2's requirement) outstanding — this makes the
    // race deterministic: exactly one advance_case_stage call can ever legally succeed, regardless
    // of which of the two concurrent calls the row lock lets through first.

    const [a, b] = await Promise.all([
      w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId }),
      w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId }),
    ]);

    const results = [a, b];
    const successes = results.filter((r) => r.error === null);
    const failures = results.filter((r) => r.error !== null);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    // The loser must fail with a stable P0001 code, never a raw Postgres lock-wait error leaking
    // through — 'no_active_stage' is what a genuinely concurrent loser gets (its blocked FOR UPDATE
    // re-reads the row post-commit, EvalPlanQual drops it since status is no longer 'active');
    // 'stage_not_ready' would be what a request that arrived strictly after the winner committed
    // gets instead (a real re-read of stage 2, which is not yet ready) — both are legitimate,
    // stable outcomes depending on true scheduling, neither is a bug.
    expect(['no_active_stage', 'stage_not_ready']).toContain(failures[0]!.error!.message);

    // The teeth: exactly ONE advance actually happened, not zero and not two. A missing/removed
    // FOR UPDATE lock would let both calls independently complete stage 1 and activate stage 2
    // (case_stages_one_active_per_case only prevents two SIMULTANEOUSLY active rows, not two
    // sequential complete-then-activate cycles) — this assertion catches that regression, which the
    // old version of this test did not.
    const { count } = await adminClient()
      .from('audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('case_id', w.caseId)
      .eq('action', 'case.stage_advanced');
    expect(count).toBe(1);

    const { data: stages } = await adminClient()
      .from('case_stages')
      .select('status')
      .eq('case_id', w.caseId)
      .order('position');
    expect(stages?.map((s) => s.status)).toEqual(['completed', 'active', 'locked']);
  });

  it('a requirements-mode stage whose visible requirement is archived (not satisfied) still blocks advancing', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance ArchivedBlocks', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'archived' }).eq('id', w.requirementIds[0]!);

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('stage_not_ready');
  });

  it('rejects advancing when a reopened requirement from an earlier stage is still pending', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance ReopenedPending', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').insert({
      organization_id: w.organizationId,
      case_id: w.caseId,
      participant_id: w.participantId,
      stage_id: w.stageIds[0],
      type: 'document',
      label: 'Corrección pendiente',
      position: 1,
      status: 'outstanding',
      reopened_from_requirement_id: w.requirementIds[0],
    });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('reopened_requirement_pending');
  });

  it('gate order: an unassigned requirement blocks even when a reopened one is ALSO pending', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance GateOrder1', stageCount: 2 });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', w.requirementIds[0]!);
    await adminClient().from('requirements').insert({
      organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
      stage_id: w.stageIds[0], type: 'document', label: 'Reabierto', position: 1,
      status: 'outstanding', reopened_from_requirement_id: w.requirementIds[0],
    });
    await adminClient().from('requirements').insert({
      organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
      stage_id: null, type: 'document', label: 'Sin etapa', position: 2,
    });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('unassigned_requirement_pending');
  });

  it('gate order: a reopened-pending requirement blocks even when the active stage is ALSO not ready', async () => {
    const w = await buildStagedCase({ name: 'Notaría Advance GateOrder2', stageCount: 2 });
    // requirementIds[0] (stage 1, active) is left outstanding — stage not ready — AND a reopened
    // requirement is also pending. reopened_requirement_pending must win (fires before Gate 3).
    await adminClient().from('requirements').insert({
      organization_id: w.organizationId, case_id: w.caseId, participant_id: w.participantId,
      stage_id: w.stageIds[0], type: 'document', label: 'Reabierto', position: 1,
      status: 'outstanding', reopened_from_requirement_id: w.requirementIds[0],
    });

    const { error } = await w.staff.client.rpc('advance_case_stage', { p_case_id: w.caseId });
    expect(error?.message).toBe('reopened_requirement_pending');
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
