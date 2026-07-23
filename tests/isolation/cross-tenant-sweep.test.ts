import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient, type DocuFlowClient } from '../helpers/clients';
import {
  buildOrganizationWorld,
  grantVerifiedAccess,
  type OrganizationWorld,
} from '../helpers/fixtures';

/**
 * The sweep required by design.md D12: for every table, a Member of one Organization must not be
 * able to read, write, or detect rows belonging to another.
 *
 * Driven by a table list rather than written per table, so adding a table to the schema without
 * adding it here is visible as an omission.
 */

const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';

type TableName =
  | 'organizations'
  | 'members'
  | 'clients'
  | 'blueprints'
  | 'cases'
  | 'case_access_grants'
  | 'requirements'
  | 'documents'
  | 'reviews'
  | 'audit_events'
  | 'reminder_deliveries'
  | 'staff_notifications'
  | 'case_participants'
  | 'blueprint_stages'
  | 'case_stages';

interface SeededRow {
  readonly table: TableName;
  readonly id: string;
}

/** Fills an Organization world with one row of every kind, and returns their ids. */
async function seedEveryTable(world: OrganizationWorld): Promise<SeededRow[]> {
  const admin = adminClient();
  const requirementId = world.requirementIds[0];
  if (!requirementId) throw new Error('fixture requirement missing');

  const granted = await grantVerifiedAccess({ world });

  const documentId = randomUUID();
  const { data: document, error: documentError } = await admin
    .from('documents')
    .insert({
      id: documentId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: requirementId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${requirementId}/${documentId}`,
      file_name: 'deed.pdf',
      content_type: 'application/pdf',
      size_bytes: 2048,
    })
    .select('id')
    .single();
  if (documentError || !document) throw new Error(`seed documents: ${documentError?.message}`);

  const { data: review, error: reviewError } = await admin
    .from('reviews')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      document_id: document.id,
      decision: 'rejected',
      reason: 'Illegible scan',
    })
    .select('id')
    .single();
  if (reviewError || !review) throw new Error(`seed reviews: ${reviewError?.message}`);

  const { data: audit, error: auditError } = await admin
    .from('audit_events')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      action: 'document.uploaded',
      target_type: 'document',
      target_id: document.id,
      actor_kind: 'system',
    })
    .select('id')
    .single();
  if (auditError || !audit) throw new Error(`seed audit_events: ${auditError?.message}`);

  const { data: member } = await admin
    .from('members')
    .select('id')
    .eq('organization_id', world.organizationId)
    .limit(1)
    .single();

  const { data: participant, error: participantError } = await admin
    .from('case_participants')
    .select('id')
    .eq('case_id', world.caseId)
    .limit(1)
    .single();
  if (participantError || !participant) throw new Error(`seed participant: ${participantError?.message}`);

  const { data: blueprintStage, error: bpStageError } = await admin
    .from('blueprint_stages')
    .insert({
      organization_id: world.organizationId,
      blueprint_id: world.blueprintId,
      name: 'Documents',
      position: 0,
    })
    .select('id')
    .single();
  if (bpStageError || !blueprintStage) throw new Error(`seed blueprint_stage: ${bpStageError?.message}`);

  const { data: caseStage, error: caseStageError } = await admin
    .from('case_stages')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      name: 'Documents',
      position: 0,
    })
    .select('id')
    .single();
  if (caseStageError || !caseStage) throw new Error(`seed case_stage: ${caseStageError?.message}`);

  const { data: reminder, error: reminderError } = await admin
    .from('reminder_deliveries')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      grant_id: granted.grantId,
      participant_id: world.participantId,
      cadence_window: 0,
      channel: 'email',
      destination: world.clientEmail,
    })
    .select('id')
    .single();
  if (reminderError || !reminder) throw new Error(`seed reminder: ${reminderError?.message}`);

  // The document insert above already fired a review_needed notification via trigger; read it.
  const { data: notification, error: notificationError } = await admin
    .from('staff_notifications')
    .select('id')
    .eq('case_id', world.caseId)
    .limit(1)
    .single();
  if (notificationError || !notification) {
    throw new Error(`seed notification: ${notificationError?.message}`);
  }

  return [
    { table: 'organizations', id: world.organizationId },
    { table: 'members', id: member?.id ?? '' },
    { table: 'clients', id: world.clientId },
    { table: 'blueprints', id: world.blueprintId },
    { table: 'cases', id: world.caseId },
    { table: 'case_access_grants', id: granted.grantId },
    { table: 'requirements', id: requirementId },
    { table: 'documents', id: document.id },
    { table: 'reviews', id: review.id },
    { table: 'audit_events', id: audit.id },
    { table: 'reminder_deliveries', id: reminder.id },
    { table: 'staff_notifications', id: notification.id },
    { table: 'case_participants', id: participant.id },
    { table: 'blueprint_stages', id: blueprintStage.id },
    { table: 'case_stages', id: caseStage.id },
  ];
}

const WRITABLE_BY_MEMBER: readonly TableName[] = [
  'organizations',
  'members',
  'clients',
  'blueprints',
  'cases',
  'case_access_grants',
  'requirements',
  'documents',
  'case_participants',
  'blueprint_stages',
  'case_stages',
];

describe('cross-tenant sweep', () => {
  let rowsInB: SeededRow[];
  let memberOfA: DocuFlowClient;
  let clientOfA: DocuFlowClient;
  let caseIdA: string;

  beforeAll(async () => {
    // Distinct client emails, deliberately unlike buildTwoOrganizationWorld's shared one. This
    // suite measures the tenant boundary; one human legitimately holding grants in both
    // Organizations is a separate property, asserted in case-access.test.ts.
    const a = await buildOrganizationWorld({
      name: 'Notaría Sweep A',
      industry: 'notary',
      clientEmail: `sweep-a-${randomUUID()}@example.test`,
    });
    const b = await buildOrganizationWorld({
      name: 'Contaduría Sweep B',
      industry: 'accounting',
      clientEmail: `sweep-b-${randomUUID()}@example.test`,
    });

    rowsInB = await seedEveryTable(b);
    await seedEveryTable(a);

    memberOfA = a.owner.client;
    caseIdA = a.caseId;
    clientOfA = (await grantVerifiedAccess({ world: a })).client;
  });

  it('covers every table in the schema', async () => {
    // Guards the guard: if a table is added and not seeded above, this fails.
    const { data } = await adminClient().from('organizations').select('id').limit(1);
    expect(data).not.toBeNull();
    expect(rowsInB.map((row) => row.table).sort()).toEqual(
      [
        'audit_events',
        'blueprints',
        'case_access_grants',
        'cases',
        'clients',
        'documents',
        'members',
        'organizations',
        'reminder_deliveries',
        'requirements',
        'reviews',
        'staff_notifications',
        'case_participants',
        'blueprint_stages',
        'case_stages',
      ].sort(),
    );
  });

  describe('reads', () => {
    it.each(['organizations', 'members', 'clients', 'blueprints', 'cases', 'case_access_grants', 'requirements', 'documents', 'reviews', 'audit_events', 'reminder_deliveries', 'staff_notifications', 'case_participants', 'blueprint_stages', 'case_stages'] as const)(
      'returns zero rows when a member of A selects %s from B',
      async (table) => {
        const target = rowsInB.find((row) => row.table === table);
        if (!target) throw new Error(`no seeded row for ${table}`);

        const { data, error } = await memberOfA.from(table).select('id').eq('id', target.id);

        expect(error).toBeNull();
        expect(data).toEqual([]);
      },
    );

    it.each(['organizations', 'members', 'clients', 'blueprints', 'cases', 'case_access_grants', 'requirements', 'documents', 'reviews', 'audit_events', 'reminder_deliveries', 'staff_notifications', 'case_participants', 'blueprint_stages', 'case_stages'] as const)(
      'makes a real B row in %s indistinguishable from a nonexistent one',
      async (table) => {
        const target = rowsInB.find((row) => row.table === table);
        if (!target) throw new Error(`no seeded row for ${table}`);

        const real = await memberOfA.from(table).select('id').eq('id', target.id);
        const absent = await memberOfA.from(table).select('id').eq('id', NONEXISTENT_ID);

        expect(real.status).toBe(absent.status);
        expect(real.error).toEqual(absent.error);
        expect(real.data).toEqual(absent.data);
      },
    );
  });

  describe('writes', () => {
    it.each(WRITABLE_BY_MEMBER)('affects zero rows when a member of A deletes from %s in B', async (table) => {
      const target = rowsInB.find((row) => row.table === table);
      if (!target) throw new Error(`no seeded row for ${table}`);

      await memberOfA.from(table).delete().eq('id', target.id);

      const { data } = await adminClient().from(table).select('id').eq('id', target.id);
      expect(data).toHaveLength(1);
    });

    it('cannot update another organization row', async () => {
      const target = rowsInB.find((row) => row.table === 'clients');
      if (!target) throw new Error('no seeded client');

      await memberOfA.from('clients').update({ full_name: 'Renamed by A' }).eq('id', target.id);

      const { data } = await adminClient()
        .from('clients')
        .select('full_name')
        .eq('id', target.id)
        .single();

      expect(data?.full_name).toBe('Test Client');
    });
  });

  describe('the granted client of A', () => {
    it('sees its own case and nothing from B', async () => {
      const { data } = await clientOfA.from('cases').select('id');
      expect(data?.map((row) => row.id)).toEqual([caseIdA]);
    });

    it.each(['organizations', 'members', 'clients', 'blueprints', 'audit_events'] as const)(
      'sees no %s rows at all',
      async (table) => {
        const { data } = await clientOfA.from(table).select('id');
        expect(data).toEqual([]);
      },
    );
  });
});
