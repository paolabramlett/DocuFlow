// tests/isolation/document-upload-sessions.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';
import { withDb } from '../helpers/db';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';

function futureIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe('document_upload_sessions: schema', () => {
  it('rejects an invalid status value', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions Schema',
      industry: 'notary',
      clientEmail: `upload-sessions-schema-${randomUUID()}@example.test`,
    });
    const admin = adminClient();

    const { error } = await admin.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: randomUUID(),
      expires_at: futureIso(30),
      status: 'bogus',
    });

    expect(error).not.toBeNull();
  });

  it('rejects completed_document_id when it does not match reserved_document_id', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions Mismatch',
      industry: 'notary',
      clientEmail: `upload-sessions-mismatch-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    const reservedId = randomUUID();

    const { error } = await admin.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: reservedId,
      completed_document_id: randomUUID(), // deliberately different
      expires_at: futureIso(30),
    });

    expect(error?.message).toContain('document_upload_sessions_completed_matches_reserved');
  });

  it('rejects claimed_at set on a row that has never been finalizing', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions ClaimedAt',
      industry: 'notary',
      clientEmail: `upload-sessions-claimedat-${randomUUID()}@example.test`,
    });
    const admin = adminClient();

    const { error } = await admin.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: randomUUID(),
      expires_at: futureIso(30),
      status: 'pending',
      claimed_at: new Date().toISOString(), // pending must never carry a claimed_at
    });

    expect(error?.message).toContain('document_upload_sessions_claimed_only_after_finalizing');
  });

  it('allows a finalizing -> completed transition to leave claimed_at in place (forensic value retained)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions ClaimedAt Transition',
      industry: 'notary',
      clientEmail: `upload-sessions-claimedat-transition-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    const reservedDocumentId = randomUUID();
    const claimedAt = new Date().toISOString();

    const storagePath = `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${reservedDocumentId}`;

    // completed_document_id carries a real FK to documents(id), so the transition below needs an
    // actual documents row (not just any UUID) sharing the reserved id.
    const { error: documentInsertError } = await admin.from('documents').insert({
      id: reservedDocumentId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      storage_path: storagePath,
      file_name: 'test.pdf',
      content_type: 'application/pdf',
      size_bytes: 1000,
    });
    expect(documentInsertError).toBeNull();

    const { data: session, error: insertError } = await admin
      .from('document_upload_sessions')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: world.requirementIds[0]!,
        participant_id: world.participantId,
        storage_path: storagePath,
        original_file_name: 'test.pdf',
        declared_content_type: 'application/pdf',
        declared_size_bytes: 1000,
        signed_url_expires_at: futureIso(120),
        reserved_document_id: reservedDocumentId,
        expires_at: futureIso(30),
        status: 'finalizing',
        claimed_at: claimedAt,
      })
      .select('id')
      .single();
    expect(insertError).toBeNull();

    // The exact transition the reviewer's Probe D reproduced as broken under the old
    // biconditional constraint: finalizing (claimed_at set) -> completed, WITHOUT nulling
    // claimed_at out. This must now succeed.
    const { error: updateError } = await admin
      .from('document_upload_sessions')
      .update({
        status: 'completed',
        completed_document_id: reservedDocumentId,
        completed_at: new Date().toISOString(),
      })
      .eq('id', session!.id);

    expect(updateError).toBeNull();

    const { data: finalRow } = await admin
      .from('document_upload_sessions')
      .select('status, claimed_at')
      .eq('id', session!.id)
      .single();
    expect(finalRow?.status).toBe('completed');
    expect(new Date(finalRow!.claimed_at!).toISOString()).toBe(claimedAt);
  });

  it('a Participant can see only their own sessions', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions Isolation',
      industry: 'notary',
      clientEmail: `upload-sessions-iso-${randomUUID()}@example.test`,
    });
    const admin = adminClient();
    const { data: session } = await admin
      .from('document_upload_sessions')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        requirement_id: world.requirementIds[0]!,
        participant_id: world.participantId,
        storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
        original_file_name: 'test.pdf',
        declared_content_type: 'application/pdf',
        declared_size_bytes: 1000,
        signed_url_expires_at: futureIso(120),
        reserved_document_id: randomUUID(),
        expires_at: futureIso(30),
      })
      .select('id')
      .single();

    const other = await createOrganizationWithOwner('Notaría Upload Sessions Isolation Other', 'notary');
    const { data: visibleToOther } = await other.owner.client
      .from('document_upload_sessions')
      .select('id')
      .eq('id', session!.id);
    expect(visibleToOther).toHaveLength(0);
  });

  it('no client role can insert a session row directly — there is no insert RLS policy at all', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upload Sessions No Direct Insert',
      industry: 'notary',
      clientEmail: `upload-sessions-nodirect-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const { error } = await granted.client.from('document_upload_sessions').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      participant_id: world.participantId,
      storage_path: `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: randomUUID(),
      expires_at: futureIso(30),
    });

    // No insert policy exists for any client role — RLS rejects this outright, distinct from a
    // business-rule rejection. This is what forces ALL creation through create_upload_session.
    expect(error).not.toBeNull();
  });
});

describe('create_upload_session', () => {
  it('creates a session for the caller\'s own participant, resolved from the requirement — never a client-supplied participant_id', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Create Session Happy',
      industry: 'notary',
      clientEmail: `create-session-happy-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const { data: rows, error } = await granted.client.rpc('create_upload_session', {
      p_requirement_id: world.requirementIds[0]!,
      p_original_file_name: 'ine.pdf',
      p_declared_content_type: 'application/pdf',
      p_declared_size_bytes: 1000,
      p_signed_url_expires_at: futureIso(120),
    });

    expect(error).toBeNull();
    const result = rows![0]!;
    expect(result.reserved_document_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result.storage_path).toContain(`/requirements/${world.requirementIds[0]}/`);
    expect(result.storage_path).toBe(
      `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${result.reserved_document_id}`,
    );

    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('participant_id, organization_id, case_id, status, storage_path, reserved_document_id')
      .eq('id', result.session_id!)
      .single();
    expect(session).toMatchObject({
      participant_id: world.participantId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      status: 'pending',
      storage_path: result.storage_path,
      reserved_document_id: result.reserved_document_id,
    });
  });

  it('rejects a requirement that does not belong to any of the caller\'s own granted participants', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Create Session WrongRequirement',
      industry: 'notary',
      clientEmail: `create-session-wrongreq-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const other = await buildOrganizationWorld({
      name: 'Notaría Create Session WrongRequirement Other',
      industry: 'notary',
      clientEmail: `create-session-wrongreq-other-${randomUUID()}@example.test`,
    });

    const { error } = await granted.client.rpc('create_upload_session', {
      p_requirement_id: other.requirementIds[0]!, // belongs to a different Case/participant entirely
      p_original_file_name: 'ine.pdf',
      p_declared_content_type: 'application/pdf',
      p_declared_size_bytes: 1000,
      p_signed_url_expires_at: futureIso(120),
    });
    expect(error?.message).toBe('requirement_not_found');
  });

  it('rejects an already-satisfied requirement', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Create Session AlreadySatisfied',
      industry: 'notary',
      clientEmail: `create-session-satisfied-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', world.requirementIds[0]!);

    const { error } = await granted.client.rpc('create_upload_session', {
      p_requirement_id: world.requirementIds[0]!,
      p_original_file_name: 'ine.pdf',
      p_declared_content_type: 'application/pdf',
      p_declared_size_bytes: 1000,
      p_signed_url_expires_at: futureIso(120),
    });
    expect(error?.message).toBe('requirement_already_satisfied');
  });

  it('rejects a declared size over the real MAX_DOCUMENT_BYTES limit, even if a client tried to bypass the TS-side check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Create Session Oversized',
      industry: 'notary',
      clientEmail: `create-session-oversized-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const { error } = await granted.client.rpc('create_upload_session', {
      p_requirement_id: world.requirementIds[0]!,
      p_original_file_name: 'huge.pdf',
      p_declared_content_type: 'application/pdf',
      p_declared_size_bytes: 26 * 1024 * 1024,
      p_signed_url_expires_at: futureIso(120),
    });
    expect(error?.message).toBe('file_too_large');
  });

  it('rejects a content type outside the real allow-list, even if a client tried to bypass the TS-side check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Create Session BadContentType',
      industry: 'notary',
      clientEmail: `create-session-badtype-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });

    const { error } = await granted.client.rpc('create_upload_session', {
      p_requirement_id: world.requirementIds[0]!,
      p_original_file_name: 'script.exe',
      p_declared_content_type: 'application/x-msdownload',
      p_declared_size_bytes: 1000,
      p_signed_url_expires_at: futureIso(120),
    });
    expect(error?.message).toBe('content_type_not_allowed');
  });
});

/** Inserts a session row directly (service role), returning its id and reserved_document_id. */
async function insertSession(
  world: Awaited<ReturnType<typeof buildOrganizationWorld>>,
  overrides: Partial<{
    status: string;
    claimedAt: string | null;
    expiresAt: string;
    completedDocumentId: string | null;
  }> = {},
) {
  const reservedDocumentId = randomUUID();
  // document_upload_sessions_completed_only_when_completed requires completed_document_id AND
  // completed_at to be non-null iff status = 'completed' (and completed_document_id must equal
  // reserved_document_id, per the other check constraint) — so a 'completed' fixture row defaults
  // completed_document_id to the reserved id right here, at insert time, rather than leaving it
  // null and trying to backfill it in a follow-up update (which the initial insert would never
  // reach, since it would violate the constraint immediately).
  const completedDocumentId =
    overrides.completedDocumentId ?? (overrides.status === 'completed' ? reservedDocumentId : null);
  const storagePath = `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${reservedDocumentId}`;

  // completed_document_id carries a real FK to documents(id) (document_upload_sessions_completed_document_id_fkey),
  // so any fixture row that sets it — 'completed' fixtures here — needs an actual documents row
  // sharing the reserved id, exactly like the schema-suite's own transition test does above.
  if (completedDocumentId) {
    const { error: documentInsertError } = await adminClient().from('documents').insert({
      id: completedDocumentId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      storage_path: storagePath,
      file_name: 'test.pdf',
      content_type: 'application/pdf',
      size_bytes: 1000,
    });
    if (documentInsertError) {
      throw new Error(`insertSession documents fixture error: ${documentInsertError.message}`);
    }
  }

  const { data, error } = await adminClient()
    .from('document_upload_sessions')
    .insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: world.requirementIds[0]!,
      participant_id: world.participantId,
      storage_path: storagePath,
      original_file_name: 'test.pdf',
      declared_content_type: 'application/pdf',
      declared_size_bytes: 1000,
      signed_url_expires_at: futureIso(120),
      reserved_document_id: reservedDocumentId,
      expires_at: overrides.expiresAt ?? futureIso(30),
      status: overrides.status ?? 'pending',
      claimed_at: overrides.claimedAt ?? null,
      completed_document_id: completedDocumentId,
      completed_at: completedDocumentId ? new Date().toISOString() : null,
    })
    .select('id, reserved_document_id')
    .single();
  if (error) {
    throw new Error(`insertSession error: ${error.message}`);
  }
  return { sessionId: data!.id as string, reservedDocumentId: data!.reserved_document_id as string };
}

describe('claim_upload_session_for_finalize', () => {
  it('claims a pending session and marks it finalizing', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Pending',
      industry: 'notary',
      clientEmail: `claim-pending-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);

    const { data, error } = await granted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ already_completed: false, completed_document_id: null });

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status, claimed_at')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('finalizing');
    expect(after?.claimed_at).not.toBeNull();
  });

  it('short-circuits a completed session without any state change', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Completed',
      industry: 'notary',
      clientEmail: `claim-completed-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world, { status: 'completed' });

    // Capture the row's state BEFORE calling claim again, then assert it's byte-identical after.
    const { data: before } = await adminClient()
      .from('document_upload_sessions')
      .select('status, claimed_at, completed_at, completed_document_id')
      .eq('id', sessionId)
      .single();

    const { data, error } = await granted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({ already_completed: true, completed_document_id: reservedDocumentId });

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status, claimed_at, completed_at, completed_document_id')
      .eq('id', sessionId)
      .single();
    expect(after).toEqual(before);
  });

  it('refuses a session currently finalizing within its lease', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim InProgress',
      industry: 'notary',
      clientEmail: `claim-inprogress-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: new Date().toISOString() });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_finalize_in_progress');
  });

  it('reclaims a session finalizing past its lease', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Reclaim',
      industry: 'notary',
      clientEmail: `claim-reclaim-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString(); // 6 min ago, past the 5-min lease
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: staleClaimedAt });

    const { data, error } = await granted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });
    expect(error).toBeNull();
    expect(data?.[0]?.already_completed).toBe(false);

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('claimed_at')
      .eq('id', sessionId)
      .single();
    expect(Date.parse(after!.claimed_at!)).toBeGreaterThan(Date.parse(staleClaimedAt));
  });

  it('refuses a cancelled session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Cancelled',
      industry: 'notary',
      clientEmail: `claim-cancelled-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'cancelled' });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_cancelled');
  });

  it('refuses an expired session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim Expired',
      industry: 'notary',
      clientEmail: `claim-expired-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'expired' });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_expired');
  });

  it('refuses a pending session whose expires_at already passed, without persisting the transition itself', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim LazyExpire',
      industry: 'notary',
      clientEmail: `claim-lazyexpire-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { expiresAt: new Date(Date.now() - 60_000).toISOString() });

    const { error } = await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_expired');

    // The RPC's own UPDATE-then-RAISE cannot commit the UPDATE (an uncaught exception rolls back
    // the whole RPC transaction, the UPDATE included), so the row is deliberately left 'pending'
    // here — persisting the pending -> expired transition is app.expire_stale_pending_sessions()'s
    // job (a later task), not this RPC's. The Participant still gets the correct error immediately.
    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('pending');
  });

  it('a Participant with a real active upload grant, but not on THIS session, cannot claim it — RLS hides the row entirely, so it is upload_session_not_found, not a separate not_authorized', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim TenantIsolation',
      industry: 'notary',
      clientEmail: `claim-tenant-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);

    const otherWorld = await buildOrganizationWorld({
      name: 'Notaría Claim TenantIsolation Other',
      industry: 'notary',
      clientEmail: `claim-tenant-other-${randomUUID()}@example.test`,
    });
    const otherGranted = await grantVerifiedAccess({ world: otherWorld, permission: 'upload' });

    const { error } = await otherGranted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });
    expect(error?.message).toBe('upload_session_not_found');
  });

  it('a Participant with only a view (not upload) grant on the SAME case cannot claim a session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Claim ViewOnlyGrant',
      industry: 'notary',
      clientEmail: `claim-viewonly-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);
    const viewOnlyGranted = await grantVerifiedAccess({ world, permission: 'view' });

    const { error } = await viewOnlyGranted.client.rpc('claim_upload_session_for_finalize', {
      p_session_id: sessionId,
    });
    expect(error?.message).toBe('upload_session_not_found');
  });
});

describe('finalize_document_upload', () => {
  it('registers the document using the VERIFIED size/content-type, not the declared ones', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Verified',
      industry: 'notary',
      clientEmail: `finalize-verified-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const { data: documentId, error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 4242, // deliberately different from insertSession's declared 1000
      p_verified_content_type: 'image/png', // deliberately different from declared 'application/pdf'
    });

    expect(error).toBeNull();
    expect(documentId).toBe(reservedDocumentId);

    const { data: doc } = await adminClient()
      .from('documents')
      .select('size_bytes, content_type')
      .eq('id', reservedDocumentId)
      .single();
    expect(doc).toMatchObject({ size_bytes: 4242, content_type: 'image/png' });

    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('status, completed_document_id, completed_at')
      .eq('id', sessionId)
      .single();
    expect(session?.status).toBe('completed');
    expect(session?.completed_document_id).toBe(reservedDocumentId);
    expect(session?.completed_at).not.toBeNull();
  });

  it('refuses a session that is not currently finalizing', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize NotFinalizing',
      industry: 'notary',
      clientEmail: `finalize-notfinalizing-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world); // still pending, never claimed

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('upload_session_not_finalizing');
  });

  it('refuses when the requirement was already satisfied during the upload', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize AlreadySatisfied',
      industry: 'notary',
      clientEmail: `finalize-satisfied-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', world.requirementIds[0]!);

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('requirement_already_satisfied');
  });

  it('refuses when the Case closed during the upload', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize CaseClosed',
      industry: 'notary',
      clientEmail: `finalize-caseclosed-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    // 'cancelled' (not 'completed'): close_case's 'completed' path additionally requires every
    // visible Requirement to already be satisfied, which would trip finalize_document_upload's
    // OWN earlier requirement_already_satisfied check before ever reaching case_not_open — this
    // test targets the case-state guard specifically, not the requirement one (covered above).
    await world.staff.client.rpc('close_case', {
      p_case_id: world.caseId,
      p_outcome: 'cancelled',
      p_closing_note: 'closed mid-upload for finalize_document_upload case_not_open coverage',
    });

    // close_case's own trigger (app.downgrade_grants_on_closure, established well before this
    // task) unconditionally downgrades every active grant on the Case from 'upload' to 'view' the
    // moment it closes. Left alone, that downgrade would make this session invisible to
    // finalize_document_upload's own 'upload'-scoped authorization query first, producing
    // upload_session_not_found before the RPC's explicit case_not_open branch is ever reached —
    // collapsing this test into a duplicate of the tenant-isolation test instead of exercising
    // what it's named for. Restoring 'upload' here isolates the one guard this test targets: it
    // simulates a still-active upload grant that outlives the Case's own open/closed state,
    // exactly the design spec's "what could have changed during the upload's own wall-clock
    // duration" scenario for case_not_open specifically (as distinct from grant_no_longer_active,
    // covered by its own separate concern).
    await adminClient()
      .from('case_access_grants')
      .update({ permission: 'upload', expires_at: futureIso(30) })
      .eq('participant_id', world.participantId);

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('case_not_open');
  });

  it('is idempotent: calling it twice never creates a second documents row', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Idempotent',
      industry: 'notary',
      clientEmail: `finalize-idempotent-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });

    const { error: secondError } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(secondError?.message).toBe('upload_session_not_finalizing'); // already 'completed'

    const { count } = await adminClient()
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('id', reservedDocumentId);
    expect(count).toBe(1);
  });

  it('THE STALE-CLAIM RACE: a late finalize call on a session reclaimed and completed by someone else is rejected, never a duplicate row', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize StaleClaimRace',
      industry: 'notary',
      clientEmail: `finalize-stalerace-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);

    // Caller A claims first.
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    // Simulate the cleanup job reclaiming A's stale lease (design spec's own worked trace) by
    // directly forcing the row back to 'pending' — this stands in for
    // reclaim_stale_finalizing_sessions() (Task 5), which isn't built yet at this point in the
    // plan; the RPC's own guard is what's under test here, not the reclaim job itself.
    await adminClient()
      .from('document_upload_sessions')
      .update({ status: 'pending', claimed_at: null })
      .eq('id', sessionId);

    // Caller B claims and completes the (reclaimed) session.
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 2000,
      p_verified_content_type: 'application/pdf',
    });

    // Caller A's own (stale) finalize call now finally executes.
    const { error: staleError } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000, // A's own, different, verified values
      p_verified_content_type: 'image/png',
    });
    expect(staleError?.message).toBe('upload_session_not_finalizing');

    // Exactly one documents row exists, with B's values, not A's.
    const { data: doc, count } = await adminClient()
      .from('documents')
      .select('size_bytes, content_type', { count: 'exact' })
      .eq('id', reservedDocumentId);
    expect(count).toBe(1);
    expect(doc?.[0]).toMatchObject({ size_bytes: 2000, content_type: 'application/pdf' });
  });

  it('a Client with no grant on this session cannot finalize it — same RLS-collapses-to-not_found reasoning as claim', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize TenantIsolation',
      industry: 'notary',
      clientEmail: `finalize-tenant-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);
    const other = await createOrganizationWithOwner('Notaría Finalize TenantOther', 'notary');

    const { error } = await other.owner.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('upload_session_not_found');
  });

  it('rejects a verified size of zero (or negative), even though the session was legitimately claimed — defense-in-depth against a direct RPC call bypassing the TS-side check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize ZeroSize',
      industry: 'notary',
      clientEmail: `finalize-zerosize-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 0,
      p_verified_content_type: 'application/pdf',
    });
    expect(error?.message).toBe('file_too_large');

    const { count } = await adminClient()
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('id', reservedDocumentId);
    expect(count).toBe(0);
  });

  it('rejects a verified content type outside the real allow-list, even though the session was legitimately claimed — defense-in-depth against a direct RPC call bypassing the TS-side check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize BadContentType',
      industry: 'notary',
      clientEmail: `finalize-badtype-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const { error } = await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/x-msdownload',
    });
    expect(error?.message).toBe('content_type_not_allowed');

    const { count } = await adminClient()
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('id', reservedDocumentId);
    expect(count).toBe(0);
  });

  it('two concurrent finalize calls on the same claimed session: exactly one succeeds, the other is rejected cleanly (never a raw duplicate-key error)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Concurrent',
      industry: 'notary',
      clientEmail: `finalize-concurrent-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId, reservedDocumentId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const [a, b] = await Promise.all([
      granted.client.rpc('finalize_document_upload', {
        p_session_id: sessionId,
        p_verified_size_bytes: 1000,
        p_verified_content_type: 'application/pdf',
      }),
      granted.client.rpc('finalize_document_upload', {
        p_session_id: sessionId,
        p_verified_size_bytes: 1000,
        p_verified_content_type: 'application/pdf',
      }),
    ]);

    const successes = [a, b].filter((r) => r.error === null);
    const failures = [a, b].filter((r) => r.error !== null);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    // The loser must fail with the stable P0001 code, never a raw Postgres 23505 (unique violation)
    // leaking through — proving the FOR UPDATE lock genuinely serialized the two calls rather than
    // letting both reach the insert.
    expect(failures[0]!.error!.message).toBe('upload_session_not_finalizing');

    const { count } = await adminClient()
      .from('documents')
      .select('*', { count: 'exact', head: true })
      .eq('id', reservedDocumentId);
    expect(count).toBe(1);
  });
});

describe('cancel_upload_session', () => {
  it('cancels a pending session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Pending',
      industry: 'notary',
      clientEmail: `cancel-pending-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error).toBeNull();

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('cancelled');
  });

  it('refuses to cancel a session mid-finalize', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel MidFinalize',
      industry: 'notary',
      clientEmail: `cancel-midfinalize-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_finalize_in_progress');

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('finalizing'); // untouched
  });

  it('refuses to cancel an already-completed session', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Completed',
      industry: 'notary',
      clientEmail: `cancel-completed-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world);
    await granted.client.rpc('claim_upload_session_for_finalize', { p_session_id: sessionId });
    await granted.client.rpc('finalize_document_upload', {
      p_session_id: sessionId,
      p_verified_size_bytes: 1000,
      p_verified_content_type: 'application/pdf',
    });

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_already_completed');
  });

  it('is idempotent from a terminal state', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Idempotent',
      industry: 'notary',
      clientEmail: `cancel-idempotent-${randomUUID()}@example.test`,
    });
    const granted = await grantVerifiedAccess({ world, permission: 'upload' });
    const { sessionId } = await insertSession(world, { status: 'cancelled' });

    const { error } = await granted.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error).toBeNull(); // no-op, not an error
  });

  it('a Client with no grant on this session cannot cancel it — same RLS-collapses-to-not_found reasoning as claim', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel TenantIsolation',
      industry: 'notary',
      clientEmail: `cancel-tenant-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world);
    const other = await createOrganizationWithOwner('Notaría Cancel TenantOther', 'notary');

    const { error } = await other.owner.client.rpc('cancel_upload_session', { p_session_id: sessionId });
    expect(error?.message).toBe('upload_session_not_found');
  });
});

// These call the app.* functions directly via withDb (a raw Postgres connection), matching this
// project's own established pattern for testing app-schema functions with no public RPC wrapper
// (see tests/isolation/case-stages-workflow.test.ts's use of the same helper).
describe('reclaim_stale_finalizing_sessions / expire_stale_pending_sessions', () => {
  it('reclaims a finalizing session past its lease to pending', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup ReclaimToPending',
      industry: 'notary',
      clientEmail: `cleanup-reclaim-pending-${randomUUID()}@example.test`,
    });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: staleClaimedAt });

    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status, claimed_at')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('pending');
    expect(after?.claimed_at).toBeNull();
  });

  it('reclaims a finalizing session past its lease directly to expired when expires_at also passed', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup ReclaimToExpired',
      industry: 'notary',
      clientEmail: `cleanup-reclaim-expired-${randomUUID()}@example.test`,
    });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const { sessionId } = await insertSession(world, {
      status: 'finalizing',
      claimedAt: staleClaimedAt,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('expired');
  });

  it('never touches a finalizing session within its live lease', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup LiveLease',
      industry: 'notary',
      clientEmail: `cleanup-livelease-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world, { status: 'finalizing', claimedAt: new Date().toISOString() });

    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('finalizing'); // untouched
  });

  it('expires a pending session whose expires_at has passed', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup ExpirePending',
      industry: 'notary',
      clientEmail: `cleanup-expirepending-${randomUUID()}@example.test`,
    });
    const { sessionId } = await insertSession(world, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    await withDb((db) => db.query('select app.expire_stale_pending_sessions()'));

    const { data: after } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', sessionId)
      .single();
    expect(after?.status).toBe('expired');
  });

  it('reclaim and expire run independently: a failure simulated in one never affects the other', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cleanup Independence',
      industry: 'notary',
      clientEmail: `cleanup-independence-${randomUUID()}@example.test`,
    });
    const staleClaimedAt = new Date(Date.now() - 6 * 60_000).toISOString();
    const { sessionId: finalizingId } = await insertSession(world, { status: 'finalizing', claimedAt: staleClaimedAt });
    const { sessionId: pendingId } = await insertSession(world, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    // Run only expire_stale_pending_sessions — proves reclaim never needed to run first or
    // alongside it for expire's own effect to be correct.
    await withDb((db) => db.query('select app.expire_stale_pending_sessions()'));
    const { data: pendingAfter } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', pendingId)
      .single();
    expect(pendingAfter?.status).toBe('expired');

    // The stale finalizing session is still untouched — expire_stale_pending_sessions never
    // reaches into 'finalizing' rows at all.
    const { data: finalizingUntouched } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', finalizingId)
      .single();
    expect(finalizingUntouched?.status).toBe('finalizing');

    // Now run reclaim on its own — proves it works standalone too.
    await withDb((db) => db.query('select app.reclaim_stale_finalizing_sessions()'));
    const { data: finalizingAfter } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', finalizingId)
      .single();
    expect(finalizingAfter?.status).toBe('pending');
  });
});
