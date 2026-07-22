import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Database } from '@/types/database';

export type DocuFlowClient = SupabaseClient<Database>;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run: npm run db:start && npm run db:env`);
  }
  return value;
}

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const ANON_KEY = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * Fixture construction only. Never use this to assert an isolation property — it would pass
 * against a schema with no policies at all, which is exactly the failure the isolation suite
 * exists to catch (design.md D12).
 */
export function adminClient(): DocuFlowClient {
  return createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** An unauthenticated client, carrying the `anon` role. */
export function anonClient(): DocuFlowClient {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface TestUser {
  readonly userId: string;
  readonly email: string;
  /** Authenticated as this user, carrying the `authenticated` role. Subject to RLS. */
  readonly client: DocuFlowClient;
}

/**
 * Creates a confirmed auth user and returns a client authenticated as them.
 *
 * Tests drive the database through this boundary rather than the service role, so every
 * assertion passes through the same policy evaluation a real request would.
 */
export async function createTestUser(emailPrefix = 'user'): Promise<TestUser> {
  const admin = adminClient();
  const email = `${emailPrefix}-${randomUUID()}@example.test`;
  const password = randomUUID();

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error || !data.user) {
    throw new Error(`Could not create test user: ${error?.message ?? 'no user returned'}`);
  }

  const client = anonClient();
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });

  if (signInError) {
    throw new Error(`Could not sign in test user: ${signInError.message}`);
  }

  return { userId: data.user.id, email, client };
}

/**
 * Creates an Organization owned by a fresh user.
 *
 * Goes through `create_organization`, the only path that inserts an Organization, so fixtures
 * exercise the same bootstrap the application uses.
 */
export async function createOrganizationWithOwner(
  name: string,
  industry: Database['public']['Tables']['organizations']['Row']['industry'] = 'notary',
): Promise<{ organizationId: string; owner: TestUser }> {
  const owner = await createTestUser('owner');

  const { data, error } = await owner.client.rpc('create_organization', {
    organization_name: name,
    organization_industry: industry,
  });

  if (error || !data) {
    throw new Error(`Could not create organization: ${error?.message ?? 'no id returned'}`);
  }

  return { organizationId: data, owner };
}

/** Adds a staff Member to an Organization, inserted by that Organization's owner. */
export async function addStaffMember(
  owner: TestUser,
  organizationId: string,
): Promise<TestUser> {
  const staff = await createTestUser('staff');

  const { error } = await owner.client.from('members').insert({
    organization_id: organizationId,
    user_id: staff.userId,
    role: 'staff',
  });

  if (error) {
    throw new Error(`Could not add staff member: ${error.message}`);
  }

  return staff;
}
