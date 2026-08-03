import { describe, expect, it } from 'vitest';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';

describe('case closure: schema', () => {
  it('rejects a cancelled Case with a blank client_closing_note', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Closure Schema', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client', email: `schema-${Date.now()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Schema Case',
    });

    const { error } = await admin
      .from('cases')
      .update({ state: 'cancelled', closed_at: new Date().toISOString() })
      .eq('id', caseId!);

    expect(error?.message).toContain('cases_cancelled_requires_note');
  });

  it('rejects a completed Case with closed_at left null', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Closure Schema 2', 'notary');
    const admin = adminClient();
    const { data: client } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Schema Client 2', email: `schema2-${Date.now()}@example.test` })
      .select('id')
      .single();
    const { data: caseId } = await owner.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: client!.id,
      case_title: 'Schema Case 2',
    });

    const { error } = await admin.from('cases').update({ state: 'completed' }).eq('id', caseId!);

    expect(error?.message).toContain('cases_closed_at_matches_state');
  });

  it('organizations.grant_reactivation_days defaults to 90 and rejects an out-of-range value', async () => {
    const { organizationId } = await createOrganizationWithOwner('Notaría Closure Schema 3', 'notary');
    const admin = adminClient();
    const { data } = await admin.from('organizations').select('grant_reactivation_days').eq('id', organizationId).single();
    expect(data?.grant_reactivation_days).toBe(90);

    const { error } = await admin.from('organizations').update({ grant_reactivation_days: 0 }).eq('id', organizationId);
    expect(error).not.toBeNull();
  });
});
