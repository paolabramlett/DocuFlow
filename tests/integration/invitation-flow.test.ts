import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminClient, anonClient, createTestUser } from '../helpers/clients';
import { buildOrganizationWorld, type OrganizationWorld } from '../helpers/fixtures';
import { clearMailbox, deliveredRecipients, waitForOtp } from '../helpers/mailbox';
import {
  InvitationError,
  issueInvitation,
  lookupInvitation,
  revokeGrant,
  sendInvitationOtp,
  verifyInvitationOtp,
} from '@/features/case-access/invitations';
import { hashInvitationToken } from '@/features/case-access/tokens';
import { findAuthUserByEmail } from '@/application/invite-member';

interface Invitation {
  readonly world: OrganizationWorld;
  readonly invitedEmail: string;
  readonly grantId: string;
  readonly token: string;
}

/**
 * A whole Organization, Case, and pending invitation, with an address nothing else has used.
 *
 * Per-test rather than shared: the auth stack enforces a resend interval per address, so tests
 * sharing one would throttle each other and report an infrastructure limit as a product failure.
 */
async function freshInvitation(label: string): Promise<Invitation> {
  const invitedEmail = `${label}-${randomUUID()}@example.test`;
  const world = await buildOrganizationWorld({
    name: 'Notaría Invite',
    industry: 'notary',
    clientEmail: invitedEmail,
  });

  const { grantId, token } = await issueInvitation(
    world.staff.client,
    {
      organizationId: world.organizationId,
      caseId: world.caseId,
      participantId: world.participantId,
      permission: 'upload',
    },
    world.staff.userId,
  );

  return { world, invitedEmail, grantId, token };
}

describe('invitation and OTP flow', () => {
  beforeEach(async () => {
    await clearMailbox();
  });

  describe('issuance', () => {
    it('stores only the hash, never the token', async () => {
      const { grantId, token, invitedEmail } = await freshInvitation('hash');

      const { data } = await adminClient()
        .from('case_access_grants')
        .select('invitation_token_hash, verified_at, auth_user_id, invited_email')
        .eq('id', grantId)
        .single();

      expect(data?.invitation_token_hash).toBe(hashInvitationToken(token));
      expect(data?.invitation_token_hash).not.toBe(token);
      expect(data?.verified_at).toBeNull();
      expect(data?.auth_user_id).toBeNull();
      expect(data?.invited_email).toBe(invitedEmail);
    });

    it('records issuance in the audit trail without the token', async () => {
      const { world, grantId, token } = await freshInvitation('audit');

      const { data } = await world.staff.client
        .from('audit_events')
        .select('action, metadata')
        .eq('target_id', grantId)
        .eq('action', 'grant.issued');

      expect(data).toHaveLength(1);
      expect(JSON.stringify(data?.[0]?.metadata)).not.toContain(token);
    });

    it('refuses issuance by a non-member', async () => {
      const { world } = await freshInvitation('outsider');
      const outsider = await createTestUser('outsider');

      await expect(
        issueInvitation(
          outsider.client,
          {
            organizationId: world.organizationId,
            caseId: world.caseId,
            participantId: world.participantId,
            permission: 'upload',
          },
          outsider.userId,
        ),
      ).rejects.toThrow();
    });
  });

  describe('the invitation URL alone', () => {
    it('reveals the organization and case only', async () => {
      const { token, invitedEmail } = await freshInvitation('context');
      const context = await lookupInvitation({ token });

      expect(context.organizationName).toBe('Notaría Invite');
      expect(context.caseTitle).toBe('Property transfer');
      expect(context.alreadyVerified).toBe(false);

      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain('Test Client');
      expect(serialized).not.toContain('Identity document');
      expect(serialized).not.toContain(invitedEmail);
    });

    it('grants no data access whatsoever', async () => {
      await freshInvitation('nodata');
      const visitor = anonClient();

      const cases = await visitor.from('cases').select('id');
      const requirements = await visitor.from('requirements').select('id');
      const documents = await visitor.from('documents').select('id');

      expect(cases.data ?? []).toEqual([]);
      expect(requirements.data ?? []).toEqual([]);
      expect(documents.data ?? []).toEqual([]);
    });

    it('rejects an unknown token', async () => {
      await expect(lookupInvitation({ token: 'not-a-real-token' })).rejects.toThrow(
        InvitationError,
      );
    });

    it('rejects a revoked invitation', async () => {
      const { world, grantId, token } = await freshInvitation('revoked');
      await revokeGrant(world.staff.client, grantId, world.staff.userId);

      await expect(lookupInvitation({ token })).rejects.toMatchObject({ reason: 'revoked' });
    });
  });

  describe('a forwarded invitation', () => {
    it('sends the passcode to the invited mailbox, never to whoever holds the link', async () => {
      const { token, invitedEmail } = await freshInvitation('forward');

      // An unintended recipient opens the forwarded URL and asks for a code.
      await sendInvitationOtp(anonClient(), { token });

      const recipients = await deliveredRecipients();

      expect(recipients).toEqual([invitedEmail]);
    });

    it('cannot be redirected: the flow accepts no address at all', async () => {
      const { token, invitedEmail } = await freshInvitation('redirect');
      const attackerEmail = `attacker-${randomUUID()}@example.test`;

      // Passing an address is not expressible in the API, so the assertion is that smuggling one
      // through changes nothing about where the code lands.
      await sendInvitationOtp(anonClient(), { token, email: attackerEmail } as { token: string });

      const recipients = await deliveredRecipients();

      expect(recipients).toContain(invitedEmail);
      expect(recipients).not.toContain(attackerEmail);
    });

    it('leaves the holder unable to verify without the mailbox', async () => {
      const { token } = await freshInvitation('noverify');
      await sendInvitationOtp(anonClient(), { token });

      await expect(
        verifyInvitationOtp(anonClient(), { token, code: '000000' }),
      ).rejects.toMatchObject({ reason: 'invalid_code' });
    });
  });

  describe('verification', () => {
    it('activates the grant, opens exactly one case, and binds the identity', async () => {
      const { world, grantId, token, invitedEmail } = await freshInvitation('verify');
      const visitor = anonClient();

      await sendInvitationOtp(visitor, { token });
      const code = await waitForOtp(invitedEmail);

      const result = await verifyInvitationOtp(visitor, { token, code });

      expect(result.grantId).toBe(grantId);
      expect(result.caseId).toBe(world.caseId);

      const { data: grant } = await adminClient()
        .from('case_access_grants')
        .select('verified_at, auth_user_id, expires_at')
        .eq('id', grantId)
        .single();

      expect(grant?.verified_at).not.toBeNull();
      expect(grant?.auth_user_id).toBe(result.authUserId);

      const ttlDays = (Date.parse(grant?.expires_at ?? '') - Date.now()) / 86_400_000;
      expect(ttlDays).toBeGreaterThan(89);
      expect(ttlDays).toBeLessThan(91);

      // The Organization's Client record now carries the identity, so a future Case reuses it.
      const { data: clientRow } = await adminClient()
        .from('clients')
        .select('auth_user_id')
        .eq('id', world.clientId)
        .single();
      expect(clientRow?.auth_user_id).toBe(result.authUserId);

      // The verified session reads its Case, and only its Case.
      const { data: readable } = await visitor.from('cases').select('id');
      expect(readable?.map((row) => row.id)).toEqual([world.caseId]);

      // Success is recorded, without the passcode.
      const { data: events } = await world.staff.client
        .from('audit_events')
        .select('metadata')
        .eq('target_id', grantId)
        .eq('action', 'grant.otp_verified');
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events?.[0]?.metadata)).not.toContain(code);
    });

    it('still delivers a real passcode when the invited address already has an unconfirmed identity', async () => {
      // Reproduces the exact gap the final whole-branch review caught: /signup can create an
      // unconfirmed auth identity for any address before that same address is ever invited to a
      // Case. sendInvitationOtp's admin.createUser(...) then fails with email_exists — if that
      // were treated as "already fine" without checking confirmation, GoTrue would keep sending
      // the link-only confirmation email forever, and this invited Client would never receive a
      // code to enter.
      const invitedEmail = `preexisting-unconfirmed-${randomUUID()}@example.test`;
      const { error: createError } = await adminClient().auth.admin.createUser({
        email: invitedEmail,
        email_confirm: false,
      });
      expect(createError).toBeNull();

      const world = await buildOrganizationWorld({
        name: 'Notaría Invite Preexisting',
        industry: 'notary',
        clientEmail: invitedEmail,
      });
      const { token } = await issueInvitation(
        world.staff.client,
        {
          organizationId: world.organizationId,
          caseId: world.caseId,
          participantId: world.participantId,
          permission: 'upload',
        },
        world.staff.userId,
      );

      const visitor = anonClient();
      await sendInvitationOtp(visitor, { token });

      // waitForOtp only matches a 6-digit code in the delivered message — it fails on its own
      // timeout if the address only ever received the link-based confirmation email instead.
      const code = await waitForOtp(invitedEmail);
      expect(code).toMatch(/^\d{6}$/);

      const confirmedUser = await findAuthUserByEmail(adminClient(), invitedEmail.toLowerCase());
      expect(confirmedUser?.email_confirmed_at).toBeTruthy();
    });
  });

  describe('throttling', () => {
    it('refuses a resend inside the cooldown', async () => {
      const { token } = await freshInvitation('cooldown');
      const visitor = anonClient();

      await sendInvitationOtp(visitor, { token });

      await expect(sendInvitationOtp(visitor, { token })).rejects.toMatchObject({
        reason: 'cooldown',
      });
    });

    it('locks after repeated wrong codes and records each failure without the code', async () => {
      const { world, grantId, token } = await freshInvitation('lockout');
      const visitor = anonClient();
      await sendInvitationOtp(visitor, { token });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(
          verifyInvitationOtp(visitor, { token, code: '111111' }),
        ).rejects.toBeInstanceOf(InvitationError);
      }

      await expect(verifyInvitationOtp(visitor, { token, code: '222222' })).rejects.toMatchObject(
        { reason: 'locked' },
      );

      const { data: grant } = await adminClient()
        .from('case_access_grants')
        .select('otp_locked_until')
        .eq('id', grantId)
        .single();
      expect(grant?.otp_locked_until).not.toBeNull();

      const { data: failures } = await world.staff.client
        .from('audit_events')
        .select('metadata')
        .eq('target_id', grantId)
        .eq('action', 'grant.otp_failed');

      expect(failures).toHaveLength(5);
      for (const failure of failures ?? []) {
        expect(JSON.stringify(failure.metadata)).not.toContain('111111');
      }
    });
  });
});
