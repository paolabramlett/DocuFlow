import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

export interface MemberDirectoryRow {
  readonly id: string;
  readonly email: string;
  readonly role: 'owner' | 'staff';
  readonly memberSince: string;
}

/**
 * The Miembros directory: every active Member of the caller's Organization, with email and role.
 *
 * Product decision: any active Member may read this, not only the owner — a team directory, not
 * an admin screen. Delegates to app.org_members_with_email, the only way to reach auth.users'
 * email from the authenticated role. That function re-checks membership itself
 * (target_organization_id in member_org_ids()); a foreign organizationId here returns zero rows,
 * not an error.
 */
export async function getOrganizationMembers(
  client: DbClient,
  organizationId: string,
): Promise<MemberDirectoryRow[]> {
  const { data, error } = await client.rpc('org_members_with_email', {
    target_organization_id: organizationId,
  });

  if (error) throw new Error(`getOrganizationMembers: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    email: row.email ?? '',
    role: row.role === 'owner' ? 'owner' : 'staff',
    memberSince: row.created_at,
  }));
}
