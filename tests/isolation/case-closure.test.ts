import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';
import { addParticipant, buildOrganizationWorld, grantVerifiedAccess, type OrganizationWorld } from '../helpers/fixtures';
import { withDb } from '../helpers/db';

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

// Module-level (not nested in any one describe block): Task 3's `describe('reopen_case', ...)`
// block, appended later in this same file, calls this too.
async function makeCaseFullyApproved(world: OrganizationWorld) {
  for (const id of world.requirementIds) {
    await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
  }
}

describe('close_case', () => {
  it('completes a Case whose every client-visible Requirement is satisfied', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Complete',
      industry: 'notary',
      clientEmail: `close-complete-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    const { data, error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error).toBeNull();
    expect(data?.state).toBe('completed');
    expect(data?.closed_at).toEqual(expect.any(String));
  });

  it('rejects completion when a Requirement is still outstanding', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Incomplete',
      industry: 'notary',
      clientEmail: `close-incomplete-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('rejects completion when the Case has zero client-visible Requirements', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close No Requirements',
      industry: 'notary',
      clientEmail: `close-none-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    }

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('a Requirement with status = archived (not merely superseded) still counts as outstanding', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Archived',
      industry: 'notary',
      clientEmail: `close-archived-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    // Directly force one Requirement to 'archived' with superseded_at left null — proving the RPC's
    // own predicate, not merely "supersedeRequirement always sets both together" (which is true in
    // the app today, but the RPC must be correct regardless).
    await adminClient()
      .from('requirements')
      .update({ status: 'archived' })
      .eq('id', world.requirementIds[0]!);

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('a multi-participant Case is not completable unless every Participant finished', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Multi',
      industry: 'notary',
      clientEmail: `close-multi-a-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    const second = await addParticipant(world, { roleLabel: 'Segundo', clientEmail: `close-multi-b-${randomUUID()}@example.test` });
    await world.staff.client.from('requirements').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      participant_id: second.participantId,
      label: 'Requisito pendiente',
      type: 'document',
      position: 0,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'completed',
    });

    expect(error?.message).toBe('documentation_incomplete');
  });

  it('cancels a Case at any time, with a note', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Cancel',
      industry: 'notary',
      clientEmail: `close-cancel-${randomUUID()}@example.test`,
    });

    const { data, error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: 'El cliente decidió no continuar.',
    });

    expect(error).toBeNull();
    expect(data?.state).toBe('cancelled');
    expect(data?.client_closing_note).toBe('El cliente decidió no continuar.');
  });

  it('rejects cancellation with a blank or whitespace-only note', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Cancel Blank',
      industry: 'notary',
      clientEmail: `close-cancel-blank-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: '   ',
    });

    expect(error?.message).toBe('cancellation_note_required');
  });

  it('rejects an invalid outcome', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Invalid',
      industry: 'notary',
      clientEmail: `close-invalid-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'archived',
    });

    expect(error?.message).toBe('invalid_outcome');
  });

  it('rejects a Case that is already closed, including directly from completed to cancelled', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Twice',
      industry: 'notary',
      clientEmail: `close-twice-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { error } = await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: 'Intento de cambio directo.',
    });

    expect(error?.message).toBe('case_not_open');
  });

  it('records the audit event atomically with the state change', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Audit',
      industry: 'notary',
      clientEmail: `close-audit-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('action, metadata, actor_auth_user_id')
      .eq('case_id', world.caseId)
      .eq('action', 'case.state_changed');
    expect(events).toHaveLength(1);
    expect(events?.[0]?.metadata).toEqual({ from: 'open', to: 'completed' });
    expect(events?.[0]?.actor_auth_user_id).toBe(world.staff.userId);
  });

  it('a granted Client cannot close a Case despite being able to SELECT it', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Client',
      industry: 'notary',
      clientEmail: `close-client-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);
    const granted = await grantVerifiedAccess({ world, permission: 'view' });

    const { data: visible } = await granted.client.from('cases').select('id').eq('id', world.caseId).maybeSingle();
    expect(visible?.id).toBe(world.caseId);

    const { error } = await granted.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    expect(error?.message).toBe('not_authorized');
  });

  it('a concurrent close_case call blocks on the row lock held by another transaction, and re-checks state once released', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Concurrent Lock',
      industry: 'notary',
      clientEmail: `close-concurrent-lock-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    await withDb(async (holder) => {
      await holder.query('begin');
      await holder.query('select * from public.cases where id = $1 for update', [world.caseId]);

      // A concurrent close_case call must now block behind the lock this connection holds.
      let resolved = false;
      const rpcPromise = world.staff.client
        .rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' })
        .then((result) => {
          resolved = true;
          return result;
        });

      await new Promise((r) => setTimeout(r, 300));
      expect(resolved).toBe(false); // still blocked — proves FOR UPDATE actually serializes here

      await holder.query('commit'); // release the lock
      const result = await rpcPromise;
      expect(result.error).toBeNull();
      expect(result.data?.state).toBe('completed');
    });
  });

  it('two genuinely concurrent close_case calls on the same Case — exactly one succeeds, one gets case_not_open', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Concurrent',
      industry: 'notary',
      clientEmail: `close-concurrent-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    const [a, b] = await Promise.all([
      world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' }),
      world.staff.client.rpc('close_case', {
        p_case_id: world.caseId,
        p_outcome: 'cancelled',
        p_closing_note: 'Carrera',
      }),
    ]);

    const errors = [a.error?.message, b.error?.message].filter((m): m is string => Boolean(m));
    const successes = [a, b].filter((r) => r.error === null);
    expect(successes).toHaveLength(1);
    expect(errors).toEqual(['case_not_open']);
  });

  it('full-rollback: if the audit_events insert fails, the Case state never becomes visible', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Close Rollback',
      industry: 'notary',
      clientEmail: `close-rollback-${randomUUID()}@example.test`,
    });
    await makeCaseFullyApproved(world);

    // postgrest-js has no "run arbitrary SQL" escape hatch, so forcing the INSERT to fail goes
    // through withDb() (tests/helpers/db.ts) — the same direct-Postgres-connection helper this
    // repo already uses for app-schema access that PostgREST can't reach (e.g.
    // tests/isolation for app.queue_reminders()).
    await withDb(async (db) => {
      await db.query('revoke insert on public.audit_events from authenticated');
      try {
        const { error } = await world.staff.client.rpc('close_case', {
          p_case_id: world.caseId,
          p_outcome: 'completed',
        });
        expect(error).not.toBeNull();

        const { data: after } = await adminClient()
          .from('cases')
          .select('state, closed_at')
          .eq('id', world.caseId)
          .single();
        expect(after?.state).toBe('open');
        expect(after?.closed_at).toBeNull();
      } finally {
        await db.query('grant insert on public.audit_events to authenticated');
      }
    });
  });
});
