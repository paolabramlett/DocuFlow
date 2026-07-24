import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { recordAuditEvent, type AuditAction, type AuditActor } from "@/features/audit/record";

type DbClient = SupabaseClient<Database>;

/**
 * Domain event logging for the application layer.
 *
 * Use cases record what happened in business terms; this delegates to the append-only audit trail
 * that already backs it. Two rules inherited from the audit spec and enforced here:
 *
 *   * Never let a logging failure fail the business operation. The write already happened; losing
 *     the event is worth surfacing in the server log, not worth rolling back a created Case.
 *   * Never pass secrets, tokens, URLs, or file contents as metadata (recordAuditEvent refuses
 *     the obvious keys, but the real rule is not to pass them).
 */
export interface DomainEvent {
  readonly organizationId: string;
  readonly caseId?: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId?: string;
  readonly actor: AuditActor;
  readonly metadata?: Record<string, unknown>;
}

export async function logDomainEvent(client: DbClient, event: DomainEvent): Promise<void> {
  try {
    await recordAuditEvent(client, event);
  } catch (cause) {
    console.error(`Domain event not recorded (${event.action}):`, cause);
  }
}

/** Logs a batch in order, without letting any single failure stop the rest. */
export async function logDomainEvents(client: DbClient, events: DomainEvent[]): Promise<void> {
  for (const event of events) await logDomainEvent(client, event);
}
