import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient, anonClient, createOrganizationWithOwner } from '../helpers/clients';
import { buildOrganizationWorld, type OrganizationWorld } from '../helpers/fixtures';
import { issueInvitation } from '@/features/case-access/invitations';

/** A fresh world with a real, issued invitation for its primary Participant. */
async function worldWithInvitation(label: string): Promise<OrganizationWorld> {
  const world = await buildOrganizationWorld({
    name: `Notaría Reissue ${label}`,
    industry: 'notary',
    clientEmail: `${label}-${randomUUID()}@example.test`,
  });
  await issueInvitation(
    world.staff.client,
    { organizationId: world.organizationId, caseId: world.caseId, participantId: world.participantId, permission: 'upload' },
    world.staff.userId,
  );
  return world;
}

describe('emit_participant_invitation', () => {
  it('rotates the token hash without touching verified_at, revoked_at, or permission', async () => {
    const world = await worldWithInvitation('rotate');
    const admin = adminClient();

    const { data: before } = await admin
      .from('case_access_grants')
      .select('invitation_token_hash, verified_at, revoked_at, permission')
      .eq('participant_id', world.participantId)
      .single();

    const { data, error } = await world.staff.client
      .rpc('emit_participant_invitation', { p_participant_id: world.participantId })
      .single();
    expect(error).toBeNull();
    expect(data?.token).toBeTruthy();

    const { data: after } = await admin
      .from('case_access_grants')
      .select('invitation_token_hash, verified_at, revoked_at, permission')
      .eq('participant_id', world.participantId)
      .single();

    expect(after?.invitation_token_hash).not.toBe(before?.invitation_token_hash);
    expect(after?.verified_at).toBe(before?.verified_at);
    expect(after?.revoked_at).toBe(before?.revoked_at);
    expect(after?.permission).toBe(before?.permission);
  });

  it('invalidates the previous token immediately', async () => {
    const world = await worldWithInvitation('invalidate');

    const { data: before } = await adminClient()
      .from('case_access_grants')
      .select('invitation_token_hash')
      .eq('participant_id', world.participantId)
      .single();

    await world.staff.client.rpc('emit_participant_invitation', { p_participant_id: world.participantId }).single();

    const { data: stillMatchesOldHash } = await adminClient()
      .from('case_access_grants')
      .select('id')
      .eq('invitation_token_hash', before!.invitation_token_hash)
      .maybeSingle();
    expect(stillMatchesOldHash).toBeNull();
  });

  it('rejects a staff member of a different organization', async () => {
    const world = await worldWithInvitation('cross-org');
    const outsider = await createOrganizationWithOwner('Notaría Outsider Reissue', 'notary');

    const { error } = await outsider.owner.client
      .rpc('emit_participant_invitation', { p_participant_id: world.participantId })
      .single();
    expect(error).not.toBeNull();
  });

  it('rejects an anonymous caller', async () => {
    const world = await worldWithInvitation('anon');

    const { error } = await anonClient()
      .rpc('emit_participant_invitation', { p_participant_id: world.participantId })
      .single();
    expect(error).not.toBeNull();
  });

  it('succeeds for the service role, matching the reminder cron\'s calling context', async () => {
    const world = await worldWithInvitation('service-role');

    const { data, error } = await adminClient()
      .rpc('emit_participant_invitation', { p_participant_id: world.participantId })
      .single();
    expect(error).toBeNull();
    expect(data?.token).toBeTruthy();
  });

  it('rejects a participant that was never invited', async () => {
    // buildOrganizationWorld creates a Case and its primary Participant but never calls
    // issueInvitation — no grant row exists yet, which is exactly the state this test needs.
    const world = await buildOrganizationWorld({
      name: 'Notaría Never Invited',
      industry: 'notary',
      clientEmail: `never-invited-${randomUUID()}@example.test`,
    });

    const { error } = await world.staff.client
      .rpc('emit_participant_invitation', { p_participant_id: world.participantId })
      .single();
    expect(error).not.toBeNull();
  });
});
