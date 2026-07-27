import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

export interface ClientDirectoryRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly caseCount: number;
}

interface RawClientRow {
  id: string;
  full_name: string;
  email: string;
  case_participants: { case_id: string }[] | null;
}

/**
 * The Clientes directory: every Client in the caller's Organization, with how many distinct
 * Cases each one participates in.
 *
 * One round trip for the whole directory — `case_participants` is embedded per Client rather
 * than queried separately, and `caseCount` is a distinct count over `case_id` computed here in
 * JS, not `case_participants.length`. A Client can appear on the same Case more than once (no
 * unique constraint prevents a duplicate participant row), so counting rows instead of distinct
 * Cases would overstate how many Cases a Client is actually part of.
 *
 * `organizationId` always comes from the caller's own resolved staff context
 * (`requireStaff()`/`getStaffContext()`), never from client input — RLS (`clients_select_own_org`)
 * enforces this independently regardless, so a foreign id here just yields nothing back.
 */
export async function getClientsDirectory(
  client: DbClient,
  organizationId: string,
): Promise<ClientDirectoryRow[]> {
  const { data, error } = await client
    .from('clients')
    .select('id, full_name, email, case_participants(case_id)')
    .eq('organization_id', organizationId)
    .order('full_name')
    .limit(500);

  if (error) {
    // Permission denied returns empty array; other errors throw
    if (error.message.includes('permission denied')) {
      return [];
    }
    throw new Error(`getClientsDirectory: ${error.message}`);
  }

  return ((data ?? []) as RawClientRow[]).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    caseCount: new Set((row.case_participants ?? []).map((p) => p.case_id)).size,
  }));
}
