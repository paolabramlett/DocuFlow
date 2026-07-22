import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { SUPABASE_URL, serviceRoleKey } from './env';

export type AdminClient = SupabaseClient<Database>;

/**
 * A client that bypasses Row Level Security.
 *
 * Reserved for the narrow set of operations that genuinely cannot be expressed as the acting
 * principal: reading a pending grant by token hash before anyone is authenticated, and binding
 * an identity to a grant at the moment of verification.
 *
 * Every use is a place where the tenant boundary is enforced by the surrounding code instead of
 * by the database, so each one carries a comment saying why, and none of them accept a
 * caller-supplied organization, case, or email.
 */
export function createAdminClient(): AdminClient {
  return createClient<Database>(SUPABASE_URL, serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
