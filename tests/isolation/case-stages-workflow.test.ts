import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';

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
