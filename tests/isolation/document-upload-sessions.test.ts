// tests/isolation/document-upload-sessions.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, createOrganizationWithOwner } from '../helpers/clients';
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

  it('rejects claimed_at set without status = finalizing, and vice versa', async () => {
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

    expect(error?.message).toContain('document_upload_sessions_claimed_only_when_finalizing');
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
    const reservedDocumentId = randomUUID();
    const path = `${world.organizationId}/cases/${world.caseId}/requirements/${world.requirementIds[0]}/${reservedDocumentId}`;

    const { data: sessionId, error } = await granted.client.rpc('create_upload_session', {
      p_requirement_id: world.requirementIds[0]!,
      p_original_file_name: 'ine.pdf',
      p_declared_content_type: 'application/pdf',
      p_declared_size_bytes: 1000,
      p_storage_path: path,
      p_reserved_document_id: reservedDocumentId,
      p_signed_url_expires_at: futureIso(120),
    });

    expect(error).toBeNull();
    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('participant_id, organization_id, case_id, status')
      .eq('id', sessionId!)
      .single();
    expect(session).toMatchObject({
      participant_id: world.participantId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      status: 'pending',
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
      p_storage_path: `x/cases/x/requirements/${other.requirementIds[0]}/${randomUUID()}`,
      p_reserved_document_id: randomUUID(),
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
      p_storage_path: `x/cases/x/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      p_reserved_document_id: randomUUID(),
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
      p_storage_path: `x/cases/x/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      p_reserved_document_id: randomUUID(),
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
      p_storage_path: `x/cases/x/requirements/${world.requirementIds[0]}/${randomUUID()}`,
      p_reserved_document_id: randomUUID(),
      p_signed_url_expires_at: futureIso(120),
    });
    expect(error?.message).toBe('content_type_not_allowed');
  });
});
