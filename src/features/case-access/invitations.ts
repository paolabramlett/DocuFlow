import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { createAdminClient, type AdminClient } from '@/lib/supabase/admin';
import { findAuthUserByEmail } from '@/application/invite-member';
import { parseInput } from '@/lib/validation/parse';
import { recordAuditEvent } from '@/features/audit/record';
import { generateInvitationToken, hashInvitationToken } from './tokens';
import {
  invitationTokenSchema,
  issueInvitationSchema,
  permissionSchema,
  verifyOtpSchema,
  type IssueInvitationInput,
} from './schemas';

type DbClient = SupabaseClient<Database>;

/** design.md R2 and the case-access spec: 90 days from activation, renewable. */
export const GRANT_TTL_DAYS = 90;

export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_MAX_FAILED_ATTEMPTS = 5;
export const OTP_LOCKOUT_MINUTES = 15;

export type InvitationFailure =
  | 'invalid_token'
  | 'already_verified'
  | 'revoked'
  | 'expired'
  | 'cooldown'
  | 'locked'
  | 'invalid_code';

export class InvitationError extends Error {
  readonly reason: InvitationFailure;

  constructor(reason: InvitationFailure, message: string) {
    super(message);
    this.name = 'InvitationError';
    this.reason = reason;
  }
}

// ------------------------------------------------------------------------------------------------
// Issuance
// ------------------------------------------------------------------------------------------------

export interface IssuedInvitation {
  readonly grantId: string;
  /** Clear text, returned once. Never stored, never logged, never audited. */
  readonly token: string;
}

/**
 * Creates a pending grant and returns its invitation token.
 *
 * Runs as the acting Staff member, so RLS decides whether they may grant access to this Case at
 * all. The invited address is copied from the Client row rather than accepted as an argument:
 * from here on, that stored address is the only one the OTP can ever be sent to.
 */
export async function issueInvitation(
  client: DbClient,
  input: IssueInvitationInput,
  actorAuthUserId: string,
): Promise<IssuedInvitation> {
  const { organizationId, caseId, participantId, permission } = parseInput(
    issueInvitationSchema,
    input,
  );

  // The invited address comes from the Participant's Client, reached through the Participant.
  // It is never an argument, so the OTP can only ever be sent to that stored address.
  const { data: participantRow, error: participantError } = await client
    .from('case_participants')
    .select('client:clients(email)')
    .eq('id', participantId)
    .eq('case_id', caseId)
    .eq('organization_id', organizationId)
    .single();

  const invitedEmail = participantRow?.client?.email;
  if (participantError || !invitedEmail) {
    throw new InvitationError('invalid_token', 'No such participant in this case');
  }

  const { token, hash } = generateInvitationToken();

  const { data: grant, error } = await client
    .from('case_access_grants')
    .insert({
      organization_id: organizationId,
      case_id: caseId,
      participant_id: participantId,
      invited_email: invitedEmail,
      invitation_token_hash: hash,
      permission,
    })
    .select('id')
    .single();

  if (error || !grant) {
    throw new Error(`Could not issue invitation: ${error?.message}`);
  }

  await recordAuditEvent(client, {
    organizationId,
    caseId,
    action: 'grant.issued',
    targetType: 'case_access_grant',
    targetId: grant.id,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { permission },
  });

  return { grantId: grant.id, token };
}

export interface ReissuedInvitation {
  readonly token: string;
  readonly invitedEmail: string;
  readonly caseId: string;
  readonly organizationId: string;
}

/**
 * Rotates an already-invited participant's Portal credential — a fresh token, the previous one
 * invalidated (its old hash no longer exists once this returns). Never creates a first invitation;
 * that's still issueInvitation()'s job, on plain grants_insert_by_member RLS.
 *
 * Thin wrapper around the `emit_participant_invitation` RPC (supabase/migrations/
 * 20260731130000_participant_invitation_reissue.sql) so the "Recordar" Server Action and the
 * reminder cron's Edge Function share the exact same reissue semantics — one implementation, not
 * two independently-evolving copies of "what does a fresh Portal link mean."
 */
export async function reissueParticipantInvitation(
  client: DbClient,
  participantId: string,
): Promise<ReissuedInvitation> {
  const { data, error } = await client
    .rpc('emit_participant_invitation', { p_participant_id: participantId })
    .single();

  if (error || !data) {
    throw new Error(`Could not reissue invitation: ${error?.message ?? 'no row returned'}`);
  }

  return {
    token: data.token,
    invitedEmail: data.invited_email,
    caseId: data.case_id,
    organizationId: data.organization_id,
  };
}

// ------------------------------------------------------------------------------------------------
// The unauthenticated side of the flow
// ------------------------------------------------------------------------------------------------

interface PendingGrant {
  readonly id: string;
  readonly organization_id: string;
  readonly case_id: string;
  readonly participant_id: string;
  readonly invited_email: string;
  readonly verified_at: string | null;
  readonly revoked_at: string | null;
  readonly otp_last_sent_at: string | null;
  readonly otp_failed_attempts: number;
  readonly otp_locked_until: string | null;
  readonly invitation_status: string;
  readonly invitation_expires_at: string;
}

/**
 * Reads a grant by token hash and enforces the invitation delivery lifecycle.
 *
 * Uses the admin client because there is no authenticated principal yet — the visitor is holding
 * a token and nothing else. That makes this function the tenant boundary for the whole
 * unauthenticated flow, so it takes no organization, case, or email from the caller: the only
 * input is the token, and every field returned is derived from the matched row.
 *
 * "Expired" is never stored — it is derived here, at read time, from invitation_expires_at,
 * exactly like grant activity and reminder eligibility elsewhere in the system. A pre-acceptance
 * invitation past its deadline is refused the same way regardless of which caller checks it.
 */
async function findGrantByToken(admin: AdminClient, token: string): Promise<PendingGrant> {
  const { data, error } = await admin
    .from('case_access_grants')
    .select(
      'id, organization_id, case_id, participant_id, invited_email, verified_at, revoked_at, otp_last_sent_at, otp_failed_attempts, otp_locked_until, invitation_status, invitation_expires_at',
    )
    .eq('invitation_token_hash', hashInvitationToken(token))
    .maybeSingle();

  if (error) throw new Error(`Could not read invitation: ${error.message}`);
  if (!data) throw new InvitationError('invalid_token', 'This invitation is not valid');
  if (data.invitation_status === 'revoked') {
    throw new InvitationError('revoked', 'This invitation is no longer valid');
  }
  if (
    data.invitation_status !== 'accepted' &&
    Date.parse(data.invitation_expires_at) < Date.now()
  ) {
    throw new InvitationError('expired', 'This invitation has expired');
  }

  return data;
}

export interface InvitationContext {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly alreadyVerified: boolean;
}

/**
 * What an unauthenticated visitor may see before proving they hold the mailbox.
 *
 * Organization name and Case title only. No client name, no requirement list, no documents —
 * a forwarded link must not become a window into the Case (case-access spec).
 */
export async function lookupInvitation(input: { token: string }): Promise<InvitationContext> {
  const { token } = parseInput(invitationTokenSchema, input);
  const admin = createAdminClient();
  const grant = await findGrantByToken(admin, token);

  const [{ data: organization }, { data: caseRow }] = await Promise.all([
    admin.from('organizations').select('name').eq('id', grant.organization_id).single(),
    admin.from('cases').select('title').eq('id', grant.case_id).single(),
  ]);

  return {
    organizationName: organization?.name ?? '',
    caseTitle: caseRow?.title ?? '',
    alreadyVerified: grant.verified_at !== null,
  };
}

/**
 * Sends a one-time passcode to the invited mailbox.
 *
 * `authClient` performs the send so the resulting session lands wherever that client keeps it.
 * The address comes from the grant row; there is no parameter that could carry a different one.
 */
export async function sendInvitationOtp(
  authClient: DbClient,
  input: { token: string },
): Promise<{ sent: true }> {
  const { token } = parseInput(invitationTokenSchema, input);
  const admin = createAdminClient();
  const grant = await findGrantByToken(admin, token);

  assertNotLocked(grant);

  if (grant.otp_last_sent_at) {
    const elapsedSeconds = (Date.now() - Date.parse(grant.otp_last_sent_at)) / 1000;
    if (elapsedSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
      throw new InvitationError('cooldown', 'A code was just sent. Try again shortly.');
    }
  }

  // Pre-confirm the invited address before requesting the OTP. GoTrue's mailer only sends the
  // numeric-code magic-link email to an *existing, confirmed* user — for a brand-new address
  // (the normal case for a first-time invitee) it instead sends the link-based confirmation email
  // now that enable_confirmations = true (needed for the real /signup flow), which carries no code
  // and would leave the invited Client with nothing to enter. Creating the user pre-confirmed
  // makes signInWithOtp treat every invited address as "existing", regardless of that global
  // setting.
  //
  // "already exists" is expected on any retry/resend, but existing does not imply confirmed: the
  // public /signup page can create an unconfirmed identity for any address, including one that
  // gets invited to a Case afterward. Treating email_exists as always-fine left that address stuck
  // getting the link-only confirmation email forever — the same failure this pre-confirm step
  // exists to prevent — so an existing-but-unconfirmed identity is explicitly confirmed here too.
  const { error: createError } = await admin.auth.admin.createUser({
    email: grant.invited_email,
    email_confirm: true,
  });
  if (createError && createError.code === 'email_exists') {
    const existing = await findAuthUserByEmail(admin, grant.invited_email.toLowerCase());
    // Absent, not null, on an unconfirmed user (verified against the actual admin API response
    // shape) — a strict `=== null` check would silently never fire.
    if (existing && !existing.email_confirmed_at) {
      const { error: confirmError } = await admin.auth.admin.updateUserById(existing.id, {
        email_confirm: true,
      });
      if (confirmError) {
        await admin
          .from('case_access_grants')
          .update({ invitation_status: 'failed', invitation_last_error: confirmError.message.slice(0, 500) })
          .eq('id', grant.id);

        await recordAuditEvent(admin, {
          organizationId: grant.organization_id,
          caseId: grant.case_id,
          action: 'grant.otp_sent',
          targetType: 'case_access_grant',
          targetId: grant.id,
          actor: { kind: 'system' },
          metadata: { delivered: false },
        });

        throw new Error(`Could not prepare invited account: ${confirmError.message}`);
      }
    }
  } else if (createError) {
    await admin
      .from('case_access_grants')
      .update({ invitation_status: 'failed', invitation_last_error: createError.message.slice(0, 500) })
      .eq('id', grant.id);

    await recordAuditEvent(admin, {
      organizationId: grant.organization_id,
      caseId: grant.case_id,
      action: 'grant.otp_sent',
      targetType: 'case_access_grant',
      targetId: grant.id,
      actor: { kind: 'system' },
      metadata: { delivered: false },
    });

    throw new Error(`Could not prepare invited account: ${createError.message}`);
  }

  const { error } = await authClient.auth.signInWithOtp({
    email: grant.invited_email,
    options: { shouldCreateUser: true },
  });

  if (error) {
    // Delivery failure is a first-class transition, not a bare exception: 'failed' is stored so
    // a retry (calling this function again) is an ordinary next step, not special-case recovery.
    await admin
      .from('case_access_grants')
      .update({ invitation_status: 'failed', invitation_last_error: error.message.slice(0, 500) })
      .eq('id', grant.id);

    await recordAuditEvent(admin, {
      organizationId: grant.organization_id,
      caseId: grant.case_id,
      action: 'grant.otp_sent',
      targetType: 'case_access_grant',
      targetId: grant.id,
      actor: { kind: 'system' },
      metadata: { delivered: false },
    });

    throw new Error(`Could not send passcode: ${error.message}`);
  }

  await admin
    .from('case_access_grants')
    .update({
      otp_last_sent_at: new Date().toISOString(),
      invitation_status: 'sent',
      invitation_sent_at: new Date().toISOString(),
      invitation_last_error: null,
    })
    .eq('id', grant.id);

  await recordAuditEvent(admin, {
    organizationId: grant.organization_id,
    caseId: grant.case_id,
    action: 'grant.otp_sent',
    targetType: 'case_access_grant',
    targetId: grant.id,
    actor: { kind: 'system' },
    metadata: { delivered: true },
  });

  return { sent: true };
}

export interface VerifiedInvitation {
  readonly grantId: string;
  readonly caseId: string;
  readonly organizationId: string;
  readonly authUserId: string;
}

/**
 * Exchanges a passcode for an active grant.
 *
 * On success the grant is bound to the verified identity and given its TTL, and the Client row
 * picks up the same identity so a future Case for this person reuses it.
 */
export async function verifyInvitationOtp(
  authClient: DbClient,
  input: { token: string; code: string },
): Promise<VerifiedInvitation> {
  const { token, code } = parseInput(verifyOtpSchema, input);
  const admin = createAdminClient();
  const grant = await findGrantByToken(admin, token);

  assertNotLocked(grant);

  const { data, error } = await authClient.auth.verifyOtp({
    email: grant.invited_email,
    token: code,
    type: 'email',
  });

  if (error || !data.user) {
    await registerFailedAttempt(admin, grant);
    throw new InvitationError('invalid_code', 'That code is not valid');
  }

  const authUserId = data.user.id;
  const expiresAt = new Date(Date.now() + GRANT_TTL_DAYS * 86_400_000);

  const { error: bindError } = await admin
    .from('case_access_grants')
    .update({
      auth_user_id: authUserId,
      verified_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      otp_failed_attempts: 0,
      otp_locked_until: null,
    })
    .eq('id', grant.id);

  if (bindError) {
    throw new Error(`Could not activate grant: ${bindError.message}`);
  }

  // Binds the identity to the Organization's Client record, reached through the Participant.
  // Scoped to this Organization's row, so it never touches another tenant's record of the same
  // person.
  const { data: participant } = await admin
    .from('case_participants')
    .select('client_id')
    .eq('id', grant.participant_id)
    .single();

  if (participant?.client_id) {
    await admin
      .from('clients')
      .update({ auth_user_id: authUserId })
      .eq('id', participant.client_id)
      .is('auth_user_id', null);
  }

  await recordAuditEvent(admin, {
    organizationId: grant.organization_id,
    caseId: grant.case_id,
    action: 'grant.otp_verified',
    targetType: 'case_access_grant',
    targetId: grant.id,
    actor: { kind: 'client', authUserId, grantId: grant.id },
  });

  return {
    grantId: grant.id,
    caseId: grant.case_id,
    organizationId: grant.organization_id,
    authUserId,
  };
}

export interface MyGrant {
  readonly grantId: string;
  readonly organizationId: string;
  readonly caseId: string;
  readonly participantId: string;
  readonly permission: string;
  /** Verified, not revoked, not expired, and permission above 'none' — the same test as the DB resolver. */
  readonly isActive: boolean;
}

/**
 * Resolves the invitation's grant for the *authenticated* caller — "resolve active grant" in the
 * client journey, run after OTP verification rather than before it.
 *
 * Unlike findGrantByToken, this runs with the caller's own session, not the admin client: RLS
 * (`organization_id in member_org_ids() OR auth_user_id = auth.uid()`) means a Client can only
 * ever get back a grant that is actually theirs. A stale or forwarded token belonging to someone
 * else resolves to nothing here, the same as it would to anyone else querying the table directly.
 */
export async function resolveMyGrant(client: DbClient, token: string): Promise<MyGrant | null> {
  const { data, error } = await client
    .from('case_access_grants')
    .select('id, organization_id, case_id, participant_id, permission, verified_at, revoked_at, expires_at')
    .eq('invitation_token_hash', hashInvitationToken(token))
    .maybeSingle();

  if (error) throw new Error(`Could not resolve grant: ${error.message}`);
  if (!data) return null;

  const isActive =
    data.verified_at !== null &&
    data.revoked_at === null &&
    data.expires_at !== null &&
    Date.parse(data.expires_at) > Date.now() &&
    data.permission !== 'none';

  return {
    grantId: data.id,
    organizationId: data.organization_id,
    caseId: data.case_id,
    participantId: data.participant_id,
    permission: data.permission,
    isActive,
  };
}

function assertNotLocked(grant: PendingGrant): void {
  if (grant.otp_locked_until && Date.parse(grant.otp_locked_until) > Date.now()) {
    throw new InvitationError('locked', 'Too many attempts. Try again later.');
  }
}

async function registerFailedAttempt(admin: AdminClient, grant: PendingGrant): Promise<void> {
  const attempts = grant.otp_failed_attempts + 1;
  const locked = attempts >= OTP_MAX_FAILED_ATTEMPTS;

  await admin
    .from('case_access_grants')
    .update({
      otp_failed_attempts: locked ? 0 : attempts,
      otp_locked_until: locked
        ? new Date(Date.now() + OTP_LOCKOUT_MINUTES * 60_000).toISOString()
        : grant.otp_locked_until,
    })
    .eq('id', grant.id);

  // The attempt is recorded; the submitted code is not, here or anywhere else.
  await recordAuditEvent(admin, {
    organizationId: grant.organization_id,
    caseId: grant.case_id,
    action: 'grant.otp_failed',
    targetType: 'case_access_grant',
    targetId: grant.id,
    actor: { kind: 'system' },
    metadata: { attempts, locked },
  });
}

// ------------------------------------------------------------------------------------------------
// Staff actions on an existing grant
// ------------------------------------------------------------------------------------------------

export async function revokeGrant(
  client: DbClient,
  grantId: string,
  actorAuthUserId: string,
): Promise<void> {
  const { data, error } = await client
    .from('case_access_grants')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', grantId)
    .select('organization_id, case_id')
    .single();

  if (error || !data) {
    throw new Error(`Could not revoke grant: ${error?.message ?? 'not found'}`);
  }

  await recordAuditEvent(client, {
    organizationId: data.organization_id,
    caseId: data.case_id,
    action: 'grant.revoked',
    targetType: 'case_access_grant',
    targetId: grantId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
  });
}

/**
 * Issues a fresh invitation for an existing Client and Case.
 *
 * Reuses the Client record rather than creating a second one, which is the whole point of
 * keeping Client durable and separate from access (case-access spec).
 */
export async function reissueInvitation(
  client: DbClient,
  expiredGrantId: string,
  actorAuthUserId: string,
): Promise<IssuedInvitation> {
  const { data: existing, error } = await client
    .from('case_access_grants')
    .select('organization_id, case_id, participant_id, permission')
    .eq('id', expiredGrantId)
    .single();

  if (error || !existing) {
    throw new Error(`Could not read grant to reissue: ${error?.message ?? 'not found'}`);
  }

  return issueInvitation(
    client,
    {
      organizationId: existing.organization_id,
      caseId: existing.case_id,
      participantId: existing.participant_id,
      // The column is CHECK-constrained rather than an enum, so generated types widen it to
      // string. Re-parsing keeps Zod as the single type boundary and turns an unexpected stored
      // value into a loud failure instead of a silent cast.
      permission: parseInput(permissionSchema, existing.permission),
    },
    actorAuthUserId,
  );
}
