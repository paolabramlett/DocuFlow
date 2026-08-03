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

describe('reopen_case', () => {
  it('rejects a Case that is not in a terminal state', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen NotTerminal',
      industry: 'notary',
      clientEmail: `reopen-notterminal-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });

    expect(error?.message).toBe('case_not_terminal');
  });

  it('reopens a completed Case back to open and clears closure fields', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Basic',
      industry: 'notary',
      clientEmail: `reopen-basic-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { error } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(error).toBeNull();

    const { data: after } = await adminClient()
      .from('cases')
      .select('state, closed_at, closed_by_auth_user_id, client_closing_note')
      .eq('id', world.caseId)
      .single();
    expect(after).toEqual(
      expect.objectContaining({ state: 'open', closed_at: null, closed_by_auth_user_id: null, client_closing_note: null }),
    );
  });

  // NOTE ON TASK ORDERING: this task (reopen_case) is deliberately implemented and tested BEFORE
  // Task 4 (the trigger swap that makes close_case's grant-downgrade actually populate
  // permission_before_closure — the CURRENT, still-active trigger, app.downgrade_grants_on_completion,
  // predates this whole feature and has never heard of that column). So every test below that
  // needs a grant already sitting in the "downgraded, with a captured prior permission" state
  // sets permission_before_closure directly via an admin write immediately after calling
  // close_case, rather than relying on close_case's real trigger side effect to have populated it
  // — exactly the same technique the "unverified grant" and "deduplicated Participant" tests
  // further down already use for their own fixture setup. Once Task 4 lands, close_case's trigger
  // populates this column for real and these direct writes become redundant-but-harmless (they'd
  // set the column to the same value the trigger already set) — no test needs to change.

  it('restores a still-active grant to its exact prior permission and a fresh expiry', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Restore',
      industry: 'notary',
      clientEmail: `reopen-restore-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger (not yet implemented) capturing the pre-downgrade permission —
    // see the NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', granted.grantId);

    const { data: downgraded } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(downgraded?.permission).toBe('view');
    expect(downgraded?.permission_before_closure).toBe('upload');

    const { data: restoredRows, error } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(error).toBeNull();
    expect(restoredRows?.map((r) => r.participant_id)).toEqual([world.participantId]);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure, expires_at')
      .eq('id', granted.grantId)
      .single();
    expect(after?.permission).toBe('upload');
    expect(after?.permission_before_closure).toBeNull();
    expect(Date.parse(after!.expires_at!)).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  it('leaves an expired grant unchanged, but still clears its stale permission_before_closure', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Expired',
      industry: 'notary',
      clientEmail: `reopen-expired-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger — see the NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', granted.grantId);
    const { data: preCheck } = await adminClient()
      .from('case_access_grants')
      .select('permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(preCheck?.permission_before_closure).toBe('upload');
    // Force expiry after the downgrade already ran.
    await adminClient()
      .from('case_access_grants')
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', granted.grantId);

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows).toHaveLength(0);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(after?.permission).toBe('view'); // unchanged, not silently bumped
    expect(after?.permission_before_closure).toBeNull(); // still cleared
  });

  it('leaves a revoked grant unchanged, but still clears its stale permission_before_closure', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Revoked',
      industry: 'notary',
      clientEmail: `reopen-revoked-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger — see the NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', granted.grantId);
    const { data: preCheck } = await adminClient()
      .from('case_access_grants')
      .select('permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(preCheck?.permission_before_closure).toBe('upload');
    await adminClient().from('case_access_grants').update({ revoked_at: new Date().toISOString() }).eq('id', granted.grantId);

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows).toHaveLength(0);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', granted.grantId)
      .single();
    expect(after?.permission).toBe('view');
    expect(after?.permission_before_closure).toBeNull();
  });

  it('leaves an unverified grant unchanged (never restores a session that never activated)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Unverified',
      industry: 'notary',
      clientEmail: `reopen-unverified-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    // Directly insert an unverified grant with a permission_before_closure value, simulating a row
    // the downgrade trigger already touched before verification ever completed (an edge case worth
    // covering even if today's flow never actually produces it).
    const { data: grant } = await adminClient()
      .from('case_access_grants')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        participant_id: world.participantId,
        invited_email: `unverified-${randomUUID()}@example.test`,
        invitation_token_hash: randomUUID(),
        permission: 'view',
        permission_before_closure: 'upload',
        expires_at: new Date(Date.now() + 1000 * 86_400_000).toISOString(),
      })
      .select('id')
      .single();
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows?.map((r) => r.participant_id)).not.toContain(world.participantId);

    const { data: after } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', grant!.id)
      .single();
    expect(after?.permission).toBe('view');
    expect(after?.permission_before_closure).toBeNull();
  });

  it('returns a deduplicated Participant set when a Participant holds two grant rows', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Dedup',
      industry: 'notary',
      clientEmail: `reopen-dedup-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    const first = await grantVerifiedAccess({ world, permission: 'upload' });
    // A second, independent grant row for the SAME Participant — case_access_grants carries no
    // uniqueness constraint on participant_id alone, so this is a legitimate state to defend
    // against even though normal issuance never produces it today.
    const { data: secondGrant } = await adminClient()
      .from('case_access_grants')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        participant_id: world.participantId,
        invited_email: `dedup-${randomUUID()}@example.test`,
        invitation_token_hash: randomUUID(),
        permission: 'upload',
        // grants_verified_is_complete requires auth_user_id whenever verified_at is set; reuse the
        // identity that already verified for this Participant via the `first` grant above.
        auth_user_id: first.authUserId,
        verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      })
      .select('id')
      .single();
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    // Simulates Task 4's trigger for BOTH grant rows, so both are genuinely restorable — see the
    // NOTE ON TASK ORDERING above this describe block's first test.
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', first.grantId);
    await adminClient().from('case_access_grants').update({ permission_before_closure: 'upload' }).eq('id', secondGrant!.id);

    const { data: restoredRows } = await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(restoredRows).toHaveLength(1);
    expect(restoredRows?.[0]?.participant_id).toBe(world.participantId);

    const { data: firstAfter } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', first.grantId)
      .single();
    const { data: secondAfter } = await adminClient()
      .from('case_access_grants')
      .select('permission, permission_before_closure')
      .eq('id', secondGrant!.id)
      .single();
    expect(firstAfter).toEqual(expect.objectContaining({ permission: 'upload', permission_before_closure: null }));
    expect(secondAfter).toEqual(expect.objectContaining({ permission: 'upload', permission_before_closure: null }));
  });

  it('a granted Client cannot reopen a Case despite being able to SELECT it', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Client',
      industry: 'notary',
      clientEmail: `reopen-client-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });
    const granted = await grantVerifiedAccess({ world, permission: 'view' });

    const { error } = await granted.client.rpc('reopen_case', { p_case_id: world.caseId });
    expect(error?.message).toBe('not_authorized');
  });

  it('the audit event exists atomically with the state change', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Reopen Audit',
      industry: 'notary',
      clientEmail: `reopen-audit-${randomUUID()}@example.test`,
    });
    for (const id of world.requirementIds) {
      await world.staff.client.from('requirements').update({ status: 'satisfied' }).eq('id', id);
    }
    await world.staff.client.rpc('close_case', { p_case_id: world.caseId, p_outcome: 'completed' });

    await world.staff.client.rpc('reopen_case', { p_case_id: world.caseId });

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('metadata')
      .eq('case_id', world.caseId)
      .eq('action', 'case.state_changed')
      .order('created_at', { ascending: false })
      .limit(1);
    expect(events?.[0]?.metadata).toEqual({ from: 'completed', to: 'open' });
  });
});
