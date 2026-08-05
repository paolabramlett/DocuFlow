import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';
import { grantVerifiedAccess } from '../helpers/fixtures';
import { getPortalCase } from '@/features/case-access/portal-queries';

/**
 * Regression coverage for a real, empirically-verified RLS bug: getPortalCase's locked-stage
 * filter (`.filter((r) => r.stageStatus !== 'locked')`) was a no-op under RLS. It derived
 * `stageStatus` from an embedded PostgREST join (`stage:case_stages(name, status)`), but
 * case_stages' only SELECT policy (case_stages_select_by_member,
 * supabase/migrations/20260723151905_stages.sql) is staff-only — the Portal runs as the
 * authenticated Participant, not an org member, so the embedded join silently resolved to `null`
 * for every row (no error). `stageStatus` was therefore always `undefined`, the filter removed
 * nothing, and a locked-stage requirement's `status: 'outstanding'` landed in the ordinary
 * pending list with a working upload control — a genuine client-facing leak of a future stage's
 * requirement.
 *
 * This test can only be caught with the real database: a component test never exercises RLS.
 */
describe('getPortalCase: locked-stage requirements are genuinely excluded (RLS-verified)', () => {
  it('excludes a requirement whose stage is locked, but includes one whose stage is active', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner(
      'Notaría Locked Stage Exclusion',
      'notary',
    );
    const staff = await addStaffMember(owner, organizationId);
    const admin = adminClient();
    const clientEmail = `locked-stage-${randomUUID()}@example.test`;

    const { data: clientRow } = await admin
      .from('clients')
      .insert({ organization_id: organizationId, full_name: 'Cliente', email: clientEmail })
      .select('id')
      .single();

    const { data: caseId } = await staff.client.rpc('create_case', {
      target_organization_id: organizationId,
      target_client_id: clientRow!.id,
      case_title: 'Locked Stage Case',
    });

    const { data: participant } = await staff.client
      .from('case_participants')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        client_id: clientRow!.id,
        role_label: 'primary',
      })
      .select('id')
      .single();

    const { data: activeStage } = await admin
      .from('case_stages')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        name: 'Etapa Activa',
        position: 0,
        status: 'active',
        activated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    const { data: lockedStage } = await admin
      .from('case_stages')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        name: 'Etapa Bloqueada',
        position: 1,
        status: 'locked',
      })
      .select('id')
      .single();

    const { data: activeReq } = await admin
      .from('requirements')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        participant_id: participant!.id,
        stage_id: activeStage!.id,
        type: 'document',
        label: 'Requisito Activo',
        position: 0,
      })
      .select('id')
      .single();

    const { data: lockedReq } = await admin
      .from('requirements')
      .insert({
        organization_id: organizationId,
        case_id: caseId!,
        participant_id: participant!.id,
        stage_id: lockedStage!.id,
        type: 'document',
        label: 'Requisito Bloqueado',
        position: 0,
      })
      .select('id')
      .single();

    const granted = await grantVerifiedAccess({
      world: {
        organizationId,
        owner,
        staff,
        clientId: clientRow!.id,
        clientEmail,
        blueprintId: '',
        caseId: caseId!,
        participantId: participant!.id,
        requirementIds: [activeReq!.id, lockedReq!.id],
      },
      permission: 'upload',
    });

    const portalCase = await getPortalCase(granted.client, granted.participantId);
    expect(portalCase).not.toBeNull();

    const labels = portalCase!.requirements.map((r) => r.label);
    expect(labels).toContain('Requisito Activo');
    expect(labels).not.toContain('Requisito Bloqueado');

    const lockedInResult = portalCase!.requirements.find((r) => r.id === lockedReq!.id);
    expect(lockedInResult).toBeUndefined();
  });
});
