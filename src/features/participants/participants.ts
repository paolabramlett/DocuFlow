import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { parseInput } from "@/lib/validation/parse";

type DbClient = SupabaseClient<Database>;

export const clientInputSchema = z.object({
  organizationId: z.string().uuid(),
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
});

/**
 * Finds the Organization's Client for an email, or creates one.
 *
 * A Client is durable and org-scoped: the same person returning for a new Case reuses their
 * record rather than spawning a duplicate. Email is unique per Organization, so this is the
 * canonical way to resolve a Client from the wizard's name+email.
 */
export async function findOrCreateClient(
  client: DbClient,
  input: z.input<typeof clientInputSchema>,
): Promise<string> {
  const { organizationId, fullName, email } = parseInput(clientInputSchema, input);

  const { data: existing, error: readError } = await client
    .from("clients")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("email", email)
    .maybeSingle();

  if (readError) throw new Error(`findOrCreateClient (read): ${readError.message}`);
  if (existing) return existing.id;

  const { data, error } = await client
    .from("clients")
    .insert({ organization_id: organizationId, full_name: fullName, email })
    .select("id")
    .single();

  if (error || !data) throw new Error(`findOrCreateClient (insert): ${error?.message}`);
  return data.id;
}

export const participantInputSchema = z.object({
  organizationId: z.string().uuid(),
  caseId: z.string().uuid(),
  clientId: z.string().uuid(),
  roleLabel: z.string().trim().min(1).max(100),
});

/** Creates a Participant linking a Client to a Case with a role. Returns its id. */
export async function createParticipant(
  client: DbClient,
  input: z.input<typeof participantInputSchema>,
): Promise<string> {
  const { organizationId, caseId, clientId, roleLabel } = parseInput(participantInputSchema, input);

  const { data, error } = await client
    .from("case_participants")
    .insert({
      organization_id: organizationId,
      case_id: caseId,
      client_id: clientId,
      role_label: roleLabel,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`createParticipant: ${error?.message}`);
  return data.id;
}
