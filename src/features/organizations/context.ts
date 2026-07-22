import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

export class OrganizationAccessError extends Error {
  constructor(message = 'No access to this organization') {
    super(message);
    this.name = 'OrganizationAccessError';
  }
}

export interface OrganizationContext {
  readonly organizationId: string;
  readonly role: 'owner' | 'staff';
  readonly authUserId: string;
}

/**
 * Resolves the Organization a request is acting in, from the route.
 *
 * The active Organization is an explicit route parameter validated on every request, never a
 * value cached in the session or a JWT claim (design.md D11). The same reasoning that keeps
 * authorization out of the token applies here: a membership that was revoked a second ago must
 * stop working now, not at the next refresh.
 *
 * The membership lookup runs as the caller and is itself governed by RLS, so this cannot report
 * a membership the caller could not otherwise see.
 */
export async function requireOrganizationContext(
  client: DbClient,
  organizationId: string,
): Promise<OrganizationContext> {
  const {
    data: { user },
    error: userError,
  } = await client.auth.getUser();

  if (userError || !user) {
    throw new OrganizationAccessError('Not authenticated');
  }

  const { data, error } = await client
    .from('members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not resolve organization context: ${error.message}`);
  }

  // Indistinguishable from "this organization does not exist", which is the point: a
  // non-member must not learn that the id is real.
  if (!data) {
    throw new OrganizationAccessError();
  }

  if (data.role !== 'owner' && data.role !== 'staff') {
    throw new OrganizationAccessError('Unrecognized role');
  }

  return { organizationId, role: data.role, authUserId: user.id };
}

/** Narrows a resolved context to Owner-only operations. */
export function requireOwner(context: OrganizationContext): OrganizationContext {
  if (context.role !== 'owner') {
    throw new OrganizationAccessError('This action requires an owner');
  }
  return context;
}
