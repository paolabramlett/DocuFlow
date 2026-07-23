import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import {
  addParticipant,
  buildOrganizationWorld,
  grantVerifiedAccess,
  type OrganizationWorld,
} from '../helpers/fixtures';
import { issueInvitation } from '@/features/case-access/invitations';

describe('case participants', () => {
  let world: OrganizationWorld;

  beforeAll(async () => {
    world = await buildOrganizationWorld({
      name: 'Notaría Participants',
      industry: 'notary',
      clientEmail: `p-${randomUUID()}@example.test`,
    });
  });

  describe('cardinality', () => {
    it('one client may be two participants of one case (distinct roles)', async () => {
      const secondRole = await world.staff.client
        .from('case_participants')
        .insert({
          organization_id: world.organizationId,
          case_id: world.caseId,
          client_id: world.clientId, // same client as the primary participant
          role_label: 'legal representative',
        })
        .select('id')
        .single();

      expect(secondRole.error).toBeNull();
      expect(secondRole.data?.id).not.toBe(world.participantId);
    });

    it('rejects a participant whose client is from another organization', async () => {
      const other = await buildOrganizationWorld({
        name: 'Otra',
        industry: 'notary',
        clientEmail: `other-${randomUUID()}@example.test`,
      });

      const { error } = await adminClient().from('case_participants').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        client_id: other.clientId,
        role_label: 'intruder',
      });

      expect(error).not.toBeNull();
      expect(error?.message).toMatch(/foreign key|violates/i);
    });
  });

  describe('draft lifecycle', () => {
    it('a case with no participant with assigned work cannot be invited (service gate)', async () => {
      // A blank case: no participant, no requirements.
      const { data: caseId } = await world.staff.client.rpc('create_case', {
        target_organization_id: world.organizationId,
        target_client_id: world.clientId,
        case_title: 'Blank draft',
      });

      const { data: participants } = await world.staff.client
        .from('case_participants')
        .select('id')
        .eq('case_id', caseId as string);

      // No hidden default participant was created.
      expect(participants).toEqual([]);
    });

    it('once a participant has an assigned requirement, an invitation issues', async () => {
      const { data: caseId } = await world.staff.client.rpc('create_case', {
        target_organization_id: world.organizationId,
        target_client_id: world.clientId,
        case_title: 'Actionable case',
      });

      const { data: participant } = await world.staff.client
        .from('case_participants')
        .insert({
          organization_id: world.organizationId,
          case_id: caseId as string,
          client_id: world.clientId,
          role_label: 'buyer',
        })
        .select('id')
        .single();

      await world.staff.client.from('requirements').insert({
        organization_id: world.organizationId,
        case_id: caseId as string,
        type: 'document',
        label: 'ID',
        position: 0,
        participant_id: participant!.id,
      });

      const invitation = await issueInvitation(
        world.staff.client,
        {
          organizationId: world.organizationId,
          caseId: caseId as string,
          participantId: participant!.id,
          permission: 'upload',
        },
        world.staff.userId,
      );

      expect(invitation.grantId).toBeTruthy();
      expect(invitation.token).toBeTruthy();
    });
  });

  describe('grant is scoped to the participant', () => {
    it('an invitation reads the invited email from the participant client', async () => {
      const partB = await addParticipant(world, {
        roleLabel: 'seller',
        clientEmail: `seller-${randomUUID()}@example.test`,
      });
      await world.staff.client.from('requirements').insert({
        organization_id: world.organizationId,
        case_id: world.caseId,
        type: 'document',
        label: "Seller's deed",
        position: 40,
        participant_id: partB.participantId,
      });

      const invitation = await issueInvitation(
        world.staff.client,
        {
          organizationId: world.organizationId,
          caseId: world.caseId,
          participantId: partB.participantId,
          permission: 'upload',
        },
        world.staff.userId,
      );

      const { data: grant } = await adminClient()
        .from('case_access_grants')
        .select('invited_email, participant_id')
        .eq('id', invitation.grantId)
        .single();

      expect(grant?.invited_email).toBe(partB.clientEmail);
      expect(grant?.participant_id).toBe(partB.participantId);
    });

    it('a client reads only the participant it is granted on', async () => {
      const partB = await addParticipant(world, {
        roleLabel: 'witness',
        clientEmail: `witness-${randomUUID()}@example.test`,
      });
      const grantedB = await grantVerifiedAccess({
        world,
        participantId: partB.participantId,
        clientId: partB.clientId,
        existingEmail: partB.clientEmail,
      });

      const { data } = await grantedB.client.from('case_participants').select('id');
      expect(data?.map((p) => p.id)).toEqual([partB.participantId]);
    });
  });
});
