import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, grantVerifiedAccess } from '../helpers/fixtures';
import { prepareUpload } from '@/application/client-portal';

describe('prepareUpload', () => {
  it('reserves a session row and returns a usable signed upload URL', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload Happy',
      industry: 'notary',
      clientEmail: `prepare-happy-${randomUUID()}@example.test`,
    });
    const token = `prepare-happy-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });

    const result = await prepareUpload(granted.client, {
      token,
      requirementId: world.requirementIds[0]!,
      fileName: 'ine.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
    });

    expect(result.signedUrl).toMatch(/^http/);
    expect(result.token).toBeTruthy();
    expect(result.path).toContain(world.requirementIds[0]!);

    const { data: session } = await adminClient()
      .from('document_upload_sessions')
      .select('status, storage_path, declared_size_bytes, declared_content_type, participant_id')
      .eq('id', result.sessionId)
      .single();
    expect(session).toMatchObject({
      status: 'pending',
      storage_path: result.path,
      declared_size_bytes: 1000,
      declared_content_type: 'application/pdf',
      participant_id: world.participantId,
    });
  });

  it('rejects an oversized file before creating any session row', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload Oversized',
      industry: 'notary',
      clientEmail: `prepare-oversized-${randomUUID()}@example.test`,
    });
    const token = `prepare-oversized-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });

    await expect(
      prepareUpload(granted.client, {
        token,
        requirementId: world.requirementIds[0]!,
        fileName: 'huge.pdf',
        contentType: 'application/pdf',
        sizeBytes: 26 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ reason: 'validation' });

    const { count } = await adminClient()
      .from('document_upload_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('requirement_id', world.requirementIds[0]!);
    expect(count).toBe(0);
  });

  it("rejects a requirement that already belongs to someone else's participant", async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload WrongParticipant',
      industry: 'notary',
      clientEmail: `prepare-wrongparticipant-a-${randomUUID()}@example.test`,
    });
    const token = `prepare-wrong-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    const other = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload WrongParticipant Other',
      industry: 'notary',
      clientEmail: `prepare-wrongparticipant-b-${randomUUID()}@example.test`,
    });

    await expect(
      prepareUpload(granted.client, {
        token,
        requirementId: other.requirementIds[0]!, // belongs to a different Case/participant entirely
        fileName: 'ine.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
      }),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('rejects an already-satisfied requirement', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Prepare Upload AlreadySatisfied',
      industry: 'notary',
      clientEmail: `prepare-satisfied-${randomUUID()}@example.test`,
    });
    const token = `prepare-satisfied-${randomUUID()}`;
    const granted = await grantVerifiedAccess({ world, permission: 'upload', token });
    await adminClient().from('requirements').update({ status: 'satisfied' }).eq('id', world.requirementIds[0]!);

    await expect(
      prepareUpload(granted.client, {
        token,
        requirementId: world.requirementIds[0]!,
        fileName: 'ine.pdf',
        contentType: 'application/pdf',
        sizeBytes: 1000,
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
  });
});
