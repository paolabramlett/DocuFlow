// src/application/update-organization.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { parseInput } from '@/lib/validation/parse';
import { UseCaseError, type ActorContext } from './errors';
import { logDomainEvent } from './events';

type DbClient = SupabaseClient<Database>;

const updateOrganizationSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  industry: z.enum(['notary', 'accounting', 'legal', 'insurance', 'hr', 'other']),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Updates an Organization's name and industry.
 *
 * Authorization is explicit and self-contained: this re-derives the actor's role from `members`
 * through the caller's own RLS-scoped `client` — it does not trust anything the caller already
 * believes about `actor`. This is one of three independent layers (the Server Action checks too,
 * and `organizations_update_by_owner` RLS is the floor); none of the three is decorative.
 *
 * Changing `industry` never touches any existing Case, Blueprint, or Requirement — it is read
 * only when *creating* new things (default terminology, starter Blueprints), never retroactively
 * (organizations.industry's own migration comment: "must never branch engine behaviour").
 */
export async function updateOrganization(
  client: DbClient,
  input: UpdateOrganizationInput,
  actor: ActorContext,
): Promise<void> {
  const { organizationId, name, industry } = parseInput(updateOrganizationSchema, input);

  const { data: membership, error: membershipError } = await client
    .from('members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', actor.authUserId)
    .maybeSingle();

  if (membershipError) {
    throw new Error(`Could not resolve membership: ${membershipError.message}`);
  }
  if (membership?.role !== 'owner') {
    throw new UseCaseError('forbidden', 'Solo el propietario puede editar esta información.');
  }

  const { error } = await client
    .from('organizations')
    .update({ name, industry })
    .eq('id', organizationId);

  if (error) {
    throw new Error(`Could not update organization: ${error.message}`);
  }

  await logDomainEvent(client, {
    organizationId,
    action: 'organization.updated',
    targetType: 'organization',
    targetId: organizationId,
    actor: { kind: 'member', authUserId: actor.authUserId },
    metadata: { name, industry },
  });
}
