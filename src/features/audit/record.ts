import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type AuditInsert = Database['public']['Tables']['audit_events']['Insert'];

export type AuditAction =
  | 'organization.updated'
  | 'case.created'
  | 'case.state_changed'
  | 'requirement.added'
  | 'requirement.renamed'
  | 'requirement.deleted'
  | 'requirement.reordered'
  | 'requirement.superseded'
  | 'grant.issued'
  | 'grant.otp_sent'
  | 'grant.otp_verified'
  | 'grant.otp_failed'
  | 'grant.permission_changed'
  | 'grant.revoked'
  | 'document.uploaded'
  | 'review.decided'
  | 'reminder.sent'
  | 'reminder.failed'
  | 'reminder.sent_manual'
  | 'member.added'
  | 'member.removed'
  | 'blueprint.created'
  | 'blueprint.updated'
  | 'blueprint.deleted';

export interface AuditEvent {
  readonly organizationId: string;
  readonly caseId?: string;
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId?: string;
  readonly actor: AuditActor;
  readonly metadata?: Record<string, unknown>;
}

export type AuditActor =
  | { readonly kind: 'member'; readonly authUserId: string }
  | { readonly kind: 'client'; readonly authUserId: string; readonly grantId: string }
  | { readonly kind: 'system' };

/**
 * Keys that must never reach the trail.
 *
 * The audit-trail spec forbids storing passcodes, tokens, signed URLs, and file contents. A
 * denylist on the way in is weaker than never passing them, but it catches the case where a
 * caller spreads a whole request object into metadata and does not notice what came with it.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'code',
  'otp',
  'otp_code',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'invitation_token',
  'signed_url',
  'signedurl',
  'url',
  'content',
  'file',
  'body',
]);

export class AuditMetadataError extends Error {}

/**
 * Writes one audit event.
 *
 * Takes the caller's own client rather than an admin one, so the event is subject to the same
 * policies as the action it describes: a principal who could not perform the action cannot
 * fabricate a record of it either.
 */
export async function recordAuditEvent(
  client: SupabaseClient<Database>,
  event: AuditEvent,
): Promise<void> {
  const metadata = event.metadata ?? {};

  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      throw new AuditMetadataError(
        `Refusing to write audit metadata key "${key}": secrets and payloads never enter the trail`,
      );
    }
  }

  const row: AuditInsert = {
    organization_id: event.organizationId,
    case_id: event.caseId ?? null,
    action: event.action,
    target_type: event.targetType,
    target_id: event.targetId ?? null,
    actor_kind: event.actor.kind,
    actor_auth_user_id: event.actor.kind === 'system' ? null : event.actor.authUserId,
    actor_grant_id: event.actor.kind === 'client' ? event.actor.grantId : null,
    metadata: metadata as Database['public']['Tables']['audit_events']['Insert']['metadata'],
  };

  const { error } = await client.from('audit_events').insert(row);

  if (error) {
    throw new Error(`Could not record audit event ${event.action}: ${error.message}`);
  }
}
