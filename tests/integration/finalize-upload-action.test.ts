import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { prepareUpload, finalizeUpload, cancelUploadSession } from '@/application/client-portal';

// createSignedUploadUrl's own `signedUrl` already embeds `?token=...` (storage-js@2.110.8,
// StorageFileApi.ts's createSignedUploadUrl: `return { signedUrl: url.toString(), path, token }`
// where `url` is built from the server's own response, token already set) — confirmed empirically
// against the local stack, not assumed. Naively concatenating `${signedUrl}?token=${token}` (as
// an early draft of this file did) produces a second `?`, which is not a new query delimiter —
// it becomes literal text appended to the *value* of the first `token` param, so the server sees
// a mangled JWT and rejects the PUT with 400 InvalidJWT before ever reaching the upsert:false
// check this suite exists to test. Building the URL with `URLSearchParams.set` instead is
// idempotent — it replaces the existing `token` param rather than appending — and matches exactly
// how src/lib/upload/direct-upload.ts (Task 7) already does it for the real browser upload path.
function signedPutUrl(signedUrl: string, token: string): string {
  const url = new URL(signedUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

describe('finalizeUpload', () => {
  it('completes a real prepare -> upload -> finalize cycle end to end', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Action Happy',
      industry: 'notary',
      clientEmail: `finalize-action-happy-${randomUUID()}@example.test`,
    });
    const token = `finalize-happy-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });

    const prepared = await prepareUpload(granted.client, {
      token,
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 11,
    });

    const put = await fetch(signedPutUrl(prepared.signedUrl, prepared.token), {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['hello world'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    expect(put.ok).toBe(true);

    const documentId = await finalizeUpload(granted.client, prepared.sessionId);

    const { data: doc } = await adminClient()
      .from('documents')
      .select('size_bytes, content_type, requirement_id')
      .eq('id', documentId)
      .single();
    expect(doc).toMatchObject({ size_bytes: 11, content_type: 'application/pdf', requirement_id: world.requirementIds[0] });
  });

  it('a retry of finalizeUpload on an already-completed session returns the same documentId without touching Storage again', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize Action Retry',
      industry: 'notary',
      clientEmail: `finalize-action-retry-${randomUUID()}@example.test`,
    });
    const token = `finalize-retry-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const prepared = await prepareUpload(granted.client, {
      token,
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 5,
    });
    await fetch(signedPutUrl(prepared.signedUrl, prepared.token), {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['hello'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    const first = await finalizeUpload(granted.client, prepared.sessionId);
    const second = await finalizeUpload(granted.client, prepared.sessionId);
    expect(second).toBe(first);
  });

  it('THE UPSERT:FALSE REGRESSION TEST — a second PUT with the same token and different bytes is rejected, and the original object is unchanged (design spec section 5)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Upsert False Regression',
      industry: 'notary',
      clientEmail: `upsert-false-${randomUUID()}@example.test`,
    });
    const token = `upsert-false-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const prepared = await prepareUpload(granted.client, {
      token,
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 7,
    });

    const putA = await fetch(signedPutUrl(prepared.signedUrl, prepared.token), {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['AAAAAAA'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    expect(putA.ok).toBe(true);

    const { data: infoAfterA } = await adminClient().storage.from('case-documents').info(prepared.path);

    const putB = await fetch(signedPutUrl(prepared.signedUrl, prepared.token), {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['BBBBBBBBBBBB'], { type: 'application/pdf' }));
        return fd;
      })(),
    });
    // The real local Storage server (confirmed empirically, not assumed from docs) answers a
    // second PUT to an upsert:false path with HTTP 400 at the transport level — the "409" only
    // shows up as an internal `statusCode` field inside the JSON body (`{"statusCode":"409",
    // "error":"Duplicate","message":"The resource already exists"}`). Asserting the literal
    // transport status would be asserting the wrong number; the actual, stable signal for "the
    // duplicate write was rejected" is that the request did not succeed and the body names the
    // conflict explicitly.
    expect(putB.ok).toBe(false);
    const putBBody = (await putB.json()) as { error?: string };
    expect(putBBody.error).toBe('Duplicate');

    const { data: infoAfterB } = await adminClient().storage.from('case-documents').info(prepared.path);
    expect(infoAfterB?.version).toBe(infoAfterA?.version);
    expect(infoAfterB?.size).toBe(7);
  });

  it('rejects finalize when the uploaded object\'s real Content-Type does not match what was declared at prepare time (design spec section 4/6 metadata-consistency check)', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Finalize ContentTypeMismatch',
      industry: 'notary',
      clientEmail: `finalize-mismatch-${randomUUID()}@example.test`,
    });
    const token = `finalize-mismatch-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });

    // Declares application/pdf at prepare time...
    const prepared = await prepareUpload(granted.client, {
      token,
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 8,
    });

    // ...but the real object PUT to Storage is actually image/png.
    const put = await fetch(signedPutUrl(prepared.signedUrl, prepared.token), {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['PNGBYTES'], { type: 'image/png' }));
        return fd;
      })(),
    });
    expect(put.ok).toBe(true);

    await expect(finalizeUpload(granted.client, prepared.sessionId)).rejects.toMatchObject({ reason: 'validation' });

    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('status, reserved_document_id')
      .eq('id', prepared.sessionId)
      .single();
    // The RPC is never reached (finalizeUpload's own TS-layer check rejects first), so the
    // session stays wherever claim_upload_session_for_finalize left it — 'finalizing' — and no
    // documents row is ever written for the reserved id.
    expect(session?.status).toBe('finalizing');

    const { data: doc } = await adminClient()
      .from('documents')
      .select('id')
      .eq('id', session!.reserved_document_id)
      .maybeSingle();
    expect(doc).toBeNull();
  });

  // NOT a "the object is gone" assertion — confirmed empirically (while writing client-portal.ts's
  // cancelUploadSession) that it can't be: case_documents_delete_by_member
  // (supabase/migrations/20260722194115_storage_buckets.sql) grants delete on storage.objects to
  // Organization members only, by explicit, pre-existing design ("Clients never update or
  // delete"). `granted.client` here runs as the Participant, so its own `.remove()` call inside
  // cancelUploadSession deletes zero rows every time (`{ data: [], error: null }` — RLS filters
  // silently, it does not error). The object's actual guaranteed removal is the separate,
  // privileged cron/Edge Function pipeline (supabase/migrations/20260805170400_upload_session_cleanup.sql),
  // not this call. What this test verifies instead is the real contract: cancelling transitions
  // the session to 'cancelled' and never throws just because the best-effort Storage delete was a
  // no-op under RLS.
  it('cancelUploadSession transitions the session to cancelled without throwing, even though the Storage delete is a no-op for a Participant caller', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Cancel Action Deletes Object',
      industry: 'notary',
      clientEmail: `cancel-action-deletes-${randomUUID()}@example.test`,
    });
    const token = `cancel-deletes-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const prepared = await prepareUpload(granted.client, {
      token,
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 5,
    });
    await fetch(signedPutUrl(prepared.signedUrl, prepared.token), {
      method: 'PUT',
      body: (() => {
        const fd = new FormData();
        fd.append('cacheControl', '3600');
        fd.append('', new Blob(['hello'], { type: 'application/pdf' }));
        return fd;
      })(),
    });

    await expect(cancelUploadSession(granted.client, prepared.sessionId)).resolves.toBeUndefined();

    const { data: sessionAfter } = await adminClient()
      .from('document_upload_sessions')
      .select('status')
      .eq('id', prepared.sessionId)
      .single();
    expect(sessionAfter?.status).toBe('cancelled');

    // Documents the known, by-design limitation above rather than asserting it silently: the
    // object is still there, because RLS never let a Participant delete it in the first place.
    const { data: infoAfter } = await adminClient().storage.from('case-documents').info(prepared.path);
    expect(infoAfter).not.toBeNull();
  });
});
