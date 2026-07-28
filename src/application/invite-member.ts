// src/application/invite-member.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { ValidationError, parseInput } from '@/lib/validation/parse';
import { UseCaseError } from './errors';
import { logDomainEvent } from './events';
import type { AdminClient } from '@/lib/supabase/admin';
import { sendTransactionalEmail, type SendTransactionalEmailInput } from '@/lib/email/resend';
import { APP_ORIGIN } from '@/lib/supabase/env';

type DbClient = SupabaseClient<Database>;

const inviteMemberSchema = z.object({
  organizationId: z.string().uuid(),
  email: z.string().trim().email(),
});

export type InviteMemberInput = z.input<typeof inviteMemberSchema>;

const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 25;

/**
 * Paginated lookup by exact, normalized email — the same bound and approach as
 * tests/helpers/fixtures.ts's findAuthUserIdByEmail and scripts/seed-demo.mjs's
 * findUserByEmail, moved into product code since this is the first place a real feature (not a
 * fixture) needs it. Never a partial/substring match.
 */
async function findAuthUserByEmail(admin: AdminClient, normalizedEmail: string) {
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(`Could not list users: ${error.message}`);

    const match = data.users.find((user) => user.email?.toLowerCase() === normalizedEmail);
    if (match) return match;
    if (data.users.length < LIST_USERS_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * Invites a person into an Organization by email, as staff.
 *
 * Authorization and audit attribution are both anchored to `client.auth.getUser()` — the
 * cryptographically verified calling session — never to anything this function is merely told.
 * `actorUser` (the inviting owner) and `invitedAuthUserId` (the identity being resolved or
 * created for the invitee) are kept in clearly separate variables throughout: conflating the two
 * was a real bug in an earlier draft of this design, where the audit event ended up crediting the
 * invited person instead of the owner who did the inviting.
 *
 * `sendEmail` exists only for tests — production callers never pass it, and the real
 * `sendTransactionalEmail` default is what actually runs.
 */
export async function inviteMember(
  client: DbClient,
  admin: AdminClient,
  input: InviteMemberInput,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<void> {
  let parsed;
  try {
    parsed = parseInput(inviteMemberSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError('validation', 'Revisa el correo.', error.issues);
    }
    throw error;
  }
  const { organizationId } = parsed;
  const normalizedEmail = parsed.email.toLowerCase();

  const {
    data: { user: actorUser },
  } = await client.auth.getUser();
  if (!actorUser) {
    throw new UseCaseError('unauthenticated', 'Tu sesión expiró. Inicia sesión de nuevo.');
  }

  const { data: actorMembership, error: actorMembershipError } = await client
    .from('members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', actorUser.id)
    .maybeSingle();
  if (actorMembershipError) {
    throw new Error(`Could not resolve membership: ${actorMembershipError.message}`);
  }
  if (actorMembership?.role !== 'owner') {
    throw new UseCaseError('forbidden', 'Solo el propietario puede invitar miembros.');
  }

  const { data: organization, error: organizationError } = await client
    .from('organizations')
    .select('name')
    .eq('id', organizationId)
    .single();
  if (organizationError || !organization) {
    throw new Error(`Could not resolve organization: ${organizationError?.message ?? 'not found'}`);
  }

  const existingAuthUser = await findAuthUserByEmail(admin, normalizedEmail);

  let invitedAuthUserId: string;
  const weCreatedThisIdentity = existingAuthUser === null;

  if (existingAuthUser) {
    invitedAuthUserId = existingAuthUser.id;
  } else {
    const { data: created, error: inviteError } = await admin.auth.admin.inviteUserByEmail(normalizedEmail, {
      redirectTo: `${APP_ORIGIN}/set-password`,
    });
    if (inviteError || !created.user) {
      throw new Error(`Could not invite user: ${inviteError?.message ?? 'no user returned'}`);
    }
    invitedAuthUserId = created.user.id;
  }

  // Only meaningful (and only reachable) for an identity that already existed — a brand-new
  // identity cannot already be a member of anything.
  if (!weCreatedThisIdentity) {
    const { data: existingMembership } = await client
      .from('members')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('user_id', invitedAuthUserId)
      .maybeSingle();
    if (existingMembership) {
      throw new UseCaseError('conflict', 'Esta persona ya es miembro de tu organización.');
    }
  }

  const { data: insertedMember, error: insertError } = await client
    .from('members')
    .insert({ organization_id: organizationId, user_id: invitedAuthUserId, role: 'staff' })
    .select('id')
    .single();

  if (insertError || !insertedMember) {
    // Postgres unique-violation (23505) on (organization_id, user_id) is the real backstop
    // against a concurrent double-invite — the pre-check query above is a fast, friendly
    // rejection, not the actual guarantee.
    if (insertError?.code === '23505') {
      throw new UseCaseError('conflict', 'Esta persona ya es miembro de tu organización.');
    }

    if (weCreatedThisIdentity) {
      try {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(invitedAuthUserId);
        if (cleanupError) {
          // A cleanup failure must never replace or mask the real failure that triggered it — the
          // original insert error is always what gets thrown, below, regardless of this outcome.
          console.error('Failed to clean up auth user after failed membership insert', {
            invitedAuthUserId,
            cleanupError,
          });
        }
      } catch (cleanupError) {
        console.error('Failed to clean up auth user after failed membership insert', {
          invitedAuthUserId,
          cleanupError,
        });
      }
    }
    throw new Error(`Could not create membership: ${insertError?.message ?? 'no row returned'}`);
  }

  // Logged immediately after the insert succeeds, before anything else — a slow external call
  // (the notification email below) must never delay the domain event describing a change that
  // already happened.
  await logDomainEvent(client, {
    organizationId,
    action: 'member.added',
    targetType: 'member',
    targetId: insertedMember.id,
    actor: { kind: 'member', authUserId: actorUser.id },
    metadata: {
      invitedEmail: normalizedEmail,
      invitedAuthUserId,
      identityAlreadyExisted: !weCreatedThisIdentity,
    },
  });

  if (!weCreatedThisIdentity) {
    // Supabase cannot "invite" an identity that already exists, so without this the person would
    // gain access with zero notice. Best-effort, last in the sequence: never let a notification
    // failure fail the membership itself — the row is already real.
    try {
      await sendEmail({
        to: normalizedEmail,
        subject: `Te agregaron al equipo de ${organization.name} en DocuFlow`,
        html: `<p>Ya tienes acceso. Entra en <a href="${APP_ORIGIN}/login">${APP_ORIGIN}/login</a> con tu correo.</p><p>Si todavía no tienes contraseña, usa "¿Olvidaste tu contraseña?" para crear una.</p>`,
        idempotencyKey: `member-added/${organizationId}/${insertedMember.id}`,
      });
    } catch (emailError) {
      console.error('Failed to send existing-member notification', {
        organizationId,
        memberId: insertedMember.id,
        status: 'email_delivery_failed',
        emailError,
      });
    }
  }
}
