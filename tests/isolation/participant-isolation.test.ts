import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient, anonClient } from '../helpers/clients';
import {
  addParticipant,
  buildOrganizationWorld,
  grantVerifiedAccess,
  type GrantedClient,
  type OrganizationWorld,
  type ParticipantHandle,
} from '../helpers/fixtures';
import { queueDueReminders } from '../helpers/db';
import {
  createDocumentDownloadUrl,
  registerDocument,
} from '@/features/documents/documents';
import { CASE_DOCUMENTS_BUCKET, documentObjectPath } from '@/lib/storage/paths';

const NONEXISTENT_ID = '00000000-0000-4000-8000-000000000000';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The blocking security property of this change: within one Case, a Client granted on Participant
 * A must not read, detect, download, or write anything belonging to Participant B, and unassigned
 * Requirements are Staff-only.
 */
describe('intra-case participant isolation', () => {
  let world: OrganizationWorld;
  let partB: ParticipantHandle;
  let clientA: GrantedClient;
  let clientB: GrantedClient;
  let reqA: string;
  let reqB: string;
  let reqUnassigned: string;
  let docBId: string;
  let docBPath: string;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Multiparty',
      industry: 'notary',
      clientEmail: `buyer-${randomUUID()}@example.test`,
    });
    // The primary participant (A) already has the three cloned requirements assigned.
    reqA = world.requirementIds[0]!;

    // A second party, B, with its own client and its own requirement.
    partB = await addParticipant(world, {
      roleLabel: 'seller',
      clientEmail: `seller-${randomUUID()}@example.test`,
    });
    const { data: rB } = await world.staff.client
      .from('requirements')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        type: 'document',
        label: "Seller's deed",
        position: 10,
        participant_id: partB.participantId,
      })
      .select('id')
      .single();
    reqB = rB!.id;

    // An unassigned, Staff-internal requirement.
    const { data: rU } = await world.staff.client
      .from('requirements')
      .insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        type: 'document',
        label: 'Internal appraisal',
        position: 20,
      })
      .select('id')
      .single();
    reqUnassigned = rU!.id;

    // A document uploaded (by staff) against B's requirement, to test cross-participant reads.
    docBId = randomUUID();
    docBPath = documentObjectPath({
      organizationId: world.organizationId,
      caseId: world.caseId,
      requirementId: reqB,
      documentId: docBId,
    });
    await adminClient().from('documents').insert({
      id: docBId,
      organization_id: world.organizationId,
      case_id: world.caseId,
      requirement_id: reqB,
      storage_path: docBPath,
      file_name: 'deed.pdf',
      content_type: 'application/pdf',
      size_bytes: 2048,
    });
    await adminClient()
      .storage.from(CASE_DOCUMENTS_BUCKET)
      .upload(docBPath, new Blob(['%PDF-1.4'], { type: 'application/pdf' }));

    clientA = await grantVerifiedAccess({ world, permission: 'upload' });
    clientB = await grantVerifiedAccess({
      world,
      participantId: partB.participantId,
      clientId: partB.clientId,
      existingEmail: partB.clientEmail,
      permission: 'upload',
    });
  });

  describe("client A against participant B's requirement", () => {
    it('(a) does not see it in requirement listings', async () => {
      const { data } = await clientA.client.from('requirements').select('id');
      const ids = data?.map((r) => r.id) ?? [];
      expect(ids).toContain(reqA);
      expect(ids).not.toContain(reqB);
      expect(ids).not.toContain(reqUnassigned);
    });

    it('(b,c) direct-by-UUID returns zero rows, metadata included', async () => {
      const { data } = await clientA.client
        .from('requirements')
        .select('id, label, instructions')
        .eq('id', reqB);
      expect(data).toEqual([]);
    });

    it('(d) cannot read its documents', async () => {
      const { data } = await clientA.client.from('documents').select('id').eq('id', docBId);
      expect(data).toEqual([]);
    });

    it('(e) cannot generate a signed URL for its document', async () => {
      await expect(createDocumentDownloadUrl(clientA.client, docBId)).rejects.toThrow();
    });

    it('(f) cannot upload against its requirement path', async () => {
      await expect(
        registerDocument(
          clientA.client,
          {
            organizationId: world.organizationId,
            caseId: world.caseId,
            requirementId: reqB,
            fileName: 'intruder.pdf',
            contentType: 'application/pdf',
            sizeBytes: 1024,
          },
          { kind: 'client', authUserId: clientA.authUserId, grantId: clientA.grantId },
        ),
      ).rejects.toThrow();
    });

    it('(g) cannot infer existence: a real B requirement looks like a nonexistent one', async () => {
      const real = await clientA.client.from('requirements').select('id').eq('id', reqB);
      const absent = await clientA.client.from('requirements').select('id').eq('id', NONEXISTENT_ID);
      expect(real.status).toBe(absent.status);
      expect(real.error).toEqual(absent.error);
      expect(real.data).toEqual(absent.data);
    });

    it('(h) is not reminded about B: its reminder counts only its own outstanding work', async () => {
      // Backdate A's grant so it is due, and satisfy all of A's requirements so A has nothing
      // outstanding — A must then not be queued, even though B still has outstanding work.
      const solo = await buildOrganizationWorld({
        name: 'Notaría ReminderScope',
        industry: 'notary',
        clientEmail: `rs-buyer-${randomUUID()}@example.test`,
      });
      const soloB = await addParticipant(solo, {
        roleLabel: 'seller',
        clientEmail: `rs-seller-${randomUUID()}@example.test`,
      });
      await solo.staff.client.from('requirements').insert({
        organization_id: solo.organizationId,
        case_id: solo.caseId,
        type: 'document',
        label: "Seller's deed",
        position: 10,
        participant_id: soloB.participantId,
      });
      await grantVerifiedAccess({ world: solo, verifiedAt: new Date(Date.now() - 10 * DAY_MS) });
      await grantVerifiedAccess({
        world: solo,
        participantId: soloB.participantId,
        clientId: soloB.clientId,
        existingEmail: soloB.clientEmail,
        verifiedAt: new Date(Date.now() - 10 * DAY_MS),
      });
      // Satisfy the buyer's (primary participant) requirements.
      await adminClient()
        .from('requirements')
        .update({ status: 'satisfied' })
        .eq('participant_id', solo.participantId);

      const queued = (await queueDueReminders()).filter((r) => r.case_id === solo.caseId);

      // Only the seller (B) is chased; the buyer (A) has no outstanding work.
      expect(queued).toHaveLength(1);
      expect(queued[0]?.participant_id).toBe(soloB.participantId);
    });

    it('(j) revoking A ends access on the next request', async () => {
      // Its own world so there is exactly one grant for this identity — otherwise a sibling grant
      // would keep access alive and mask the revocation.
      const w = await buildOrganizationWorld({
        name: 'Notaría Revoke',
        industry: 'notary',
        clientEmail: `revoke-${randomUUID()}@example.test`,
      });
      const granted = await grantVerifiedAccess({ world: w, permission: 'view' });

      const before = await granted.client.from('requirements').select('id');
      expect(before.data?.length).toBeGreaterThan(0);

      await w.staff.client
        .from('case_access_grants')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', granted.grantId);

      const after = await granted.client.from('requirements').select('id');
      expect(after.data).toEqual([]);
    });
  });

  describe('symmetry and staff visibility', () => {
    it("client B cannot see A's requirement either", async () => {
      const { data } = await clientB.client.from('requirements').select('id').eq('id', reqA);
      expect(data).toEqual([]);
    });

    it('client B sees exactly its own assigned requirement', async () => {
      const { data } = await clientB.client.from('requirements').select('id');
      expect(data?.map((r) => r.id)).toEqual([reqB]);
    });

    it('neither client sees the unassigned staff requirement', async () => {
      const a = await clientA.client.from('requirements').select('id').eq('id', reqUnassigned);
      const b = await clientB.client.from('requirements').select('id').eq('id', reqUnassigned);
      expect(a.data).toEqual([]);
      expect(b.data).toEqual([]);
    });

    it('staff see every requirement — both participants and the unassigned one', async () => {
      const { data } = await world.staff.client
        .from('requirements')
        .select('id')
        .eq('case_id', world.caseId);
      const ids = data?.map((r) => r.id) ?? [];
      expect(ids).toEqual(expect.arrayContaining([reqA, reqB, reqUnassigned]));
    });

    it('an unauthenticated visitor sees nothing', async () => {
      const { data } = await anonClient().from('requirements').select('id').eq('id', reqB);
      expect(data ?? []).toEqual([]);
    });
  });

  describe('case_ready spans the whole case', () => {
    it('is not ready while an unassigned staff requirement is outstanding', async () => {
      const w = await buildOrganizationWorld({
        name: 'Notaría Ready',
        industry: 'notary',
        clientEmail: `ready-${randomUUID()}@example.test`,
      });
      // Add one unassigned staff requirement, then satisfy every assigned one.
      await w.staff.client.from('requirements').insert({
        organization_id: w.organizationId,
        case_id: w.caseId,
        type: 'document',
        label: 'Internal check',
        position: 30,
      });
      await adminClient()
        .from('requirements')
        .update({ status: 'satisfied' })
        .eq('participant_id', w.participantId);

      const ready = await w.staff.client
        .from('staff_notifications')
        .select('id')
        .eq('case_id', w.caseId)
        .eq('reason', 'case_ready');
      expect(ready.data).toEqual([]);
    });

    it('becomes ready once the unassigned requirement is also satisfied', async () => {
      const w = await buildOrganizationWorld({
        name: 'Notaría ReadyDone',
        industry: 'notary',
        clientEmail: `readydone-${randomUUID()}@example.test`,
      });
      const { data: internal } = await w.staff.client
        .from('requirements')
        .insert({
          organization_id: w.organizationId,
          case_id: w.caseId,
          type: 'document',
          label: 'Internal check',
          position: 30,
        })
        .select('id')
        .single();

      await adminClient()
        .from('requirements')
        .update({ status: 'satisfied' })
        .eq('participant_id', w.participantId);
      // The final satisfy — the unassigned one — must trigger case_ready.
      await w.staff.client
        .from('requirements')
        .update({ status: 'satisfied' })
        .eq('id', internal!.id);

      const ready = await w.staff.client
        .from('staff_notifications')
        .select('id')
        .eq('case_id', w.caseId)
        .eq('reason', 'case_ready');
      expect(ready.data).toHaveLength(1);
    });
  });
});
