import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld, type OrganizationWorld } from '../helpers/fixtures';
import { issueInvitation, revokeGrant } from '@/features/case-access/invitations';

/**
 * The invitation delivery lifecycle (docs/CLIENT_PORTAL.md) is its own state machine, enforced by
 * `app.sync_invitation_status` (migration 20260724195215), deliberately separate from the grant's
 * own access lifecycle (verified/revoked/expires_at). These tests exercise the trigger directly
 * through admin writes, the same way the invitation's fields are read: as a DB invariant, not an
 * application-level convention that call sites could bypass.
 */

async function freshGrant(label: string): Promise<{ world: OrganizationWorld; grantId: string }> {
  const world = await buildOrganizationWorld({
    name: 'Notaría Lifecycle',
    industry: 'notary',
    clientEmail: `${label}-${randomUUID()}@example.test`,
  });

  const { grantId } = await issueInvitation(
    world.staff.client,
    {
      organizationId: world.organizationId,
      caseId: world.caseId,
      participantId: world.participantId,
      permission: 'upload',
    },
    world.staff.userId,
  );

  return { world, grantId };
}

async function statusOf(grantId: string): Promise<string> {
  const { data } = await adminClient()
    .from('case_access_grants')
    .select('invitation_status')
    .eq('id', grantId)
    .single();
  return data?.invitation_status ?? '';
}

/**
 * The fields a real `verifyInvitationOtp` writes together. `grants_verified_is_complete` requires
 * auth_user_id and expires_at alongside verified_at, so exercising the trigger with verified_at
 * alone would just fail the constraint and silently write nothing.
 */
async function acceptanceFields(label: string) {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: `${label}-${randomUUID()}@example.test`,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create identity: ${error?.message}`);

  return {
    verified_at: new Date().toISOString(),
    auth_user_id: data.user.id,
    expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
  };
}

describe('invitation delivery lifecycle (trigger invariants)', () => {
  it('starts pending, with a 7-day deadline', async () => {
    const { grantId } = await freshGrant('default');

    const { data } = await adminClient()
      .from('case_access_grants')
      .select('invitation_status, invitation_sent_at, invitation_last_error, invitation_expires_at')
      .eq('id', grantId)
      .single();

    expect(data?.invitation_status).toBe('pending');
    expect(data?.invitation_sent_at).toBeNull();
    expect(data?.invitation_last_error).toBeNull();

    const ttlDays = (Date.parse(data?.invitation_expires_at ?? '') - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(6.9);
    expect(ttlDays).toBeLessThan(7.1);
  });

  it('moves to accepted when the grant is verified', async () => {
    const { grantId } = await freshGrant('accept');

    // Stands in for a real OTP exchange (invitation-flow.test.ts already covers that path) —
    // what's under test here is the trigger reacting to verified_at, not the OTP exchange itself.
    const { error } = await adminClient()
      .from('case_access_grants')
      .update(await acceptanceFields('accept'))
      .eq('id', grantId);
    if (error) throw error;

    expect(await statusOf(grantId)).toBe('accepted');
  });

  it('revocation wins even over an already-accepted invitation', async () => {
    const { world, grantId } = await freshGrant('revoke-after-accept');

    const { error } = await adminClient()
      .from('case_access_grants')
      .update(await acceptanceFields('revoke-after-accept'))
      .eq('id', grantId);
    if (error) throw error;
    expect(await statusOf(grantId)).toBe('accepted');

    await revokeGrant(world.staff.client, grantId, world.staff.userId);

    expect(await statusOf(grantId)).toBe('revoked');
  });

  it('keeps a revoked invitation revoked no matter what else changes afterward', async () => {
    const { world, grantId } = await freshGrant('revoked-is-final');

    await revokeGrant(world.staff.client, grantId, world.staff.userId);
    expect(await statusOf(grantId)).toBe('revoked');

    // An unrelated update, and even one that looks like a fresh acceptance — neither should move
    // the invitation off 'revoked'. Revocation must never be a state a later write can undo.
    const { error: unrelated } = await adminClient()
      .from('case_access_grants')
      .update({ permission: 'view' })
      .eq('id', grantId);
    if (unrelated) throw unrelated;
    expect(await statusOf(grantId)).toBe('revoked');

    const { error: looksAccepted } = await adminClient()
      .from('case_access_grants')
      .update(await acceptanceFields('revoked-is-final'))
      .eq('id', grantId);
    if (looksAccepted) throw looksAccepted;
    expect(await statusOf(grantId)).toBe('revoked');
  });

  it('never stores "expired" — it stays whatever it was, past its own deadline', async () => {
    const { grantId } = await freshGrant('expired-not-stored');

    const { error } = await adminClient()
      .from('case_access_grants')
      .update({ invitation_status: 'sent', invitation_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', grantId);
    if (error) throw error;

    // The column itself never becomes 'expired': expiry is derived at read time
    // (findGrantByToken), never written by any trigger or job.
    expect(await statusOf(grantId)).toBe('sent');
  });
});
