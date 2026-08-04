import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';
import { parseInput } from '@/lib/validation/parse';
import { recordAuditEvent, type AuditActor } from '@/features/audit/record';
import { CASE_DOCUMENTS_BUCKET, documentObjectPath } from '@/lib/storage/paths';
import {
  reviewDecisionSchema,
  uploadDocumentSchema,
  type ReviewDecisionInput,
  type UploadDocumentInput,
} from './schemas';

type DbClient = SupabaseClient<Database>;

/** Short enough that a leaked URL is stale before it travels (design.md, Risks). */
export const SIGNED_URL_TTL_SECONDS = 120;

export interface UploadedDocument {
  readonly documentId: string;
  readonly storagePath: string;
}

/**
 * Registers an uploaded Document.
 *
 * Runs entirely as the acting principal, so a Client without `upload` permission on this Case is
 * refused by policy rather than by a check here. Validation runs first so an oversized or
 * disallowed file never produces a row or an object.
 */
export async function registerDocument(
  client: DbClient,
  input: UploadDocumentInput,
  actor: AuditActor,
): Promise<UploadedDocument> {
  const { organizationId, caseId, requirementId, fileName, contentType, sizeBytes, documentId: providedId } =
    parseInput(uploadDocumentSchema, input);

  const documentId = providedId ?? randomUUID();
  const storagePath = documentObjectPath({
    organizationId,
    caseId,
    requirementId,
    documentId,
  });

  const { error } = await client.from('documents').insert({
    id: documentId,
    organization_id: organizationId,
    case_id: caseId,
    requirement_id: requirementId,
    storage_path: storagePath,
    file_name: fileName,
    content_type: contentType,
    size_bytes: sizeBytes,
    uploaded_by_auth_user_id: actor.kind === 'system' ? null : actor.authUserId,
  });

  if (error) {
    throw new Error(`Could not register document: ${error.message}`);
  }

  await recordAuditEvent(client, {
    organizationId,
    caseId,
    action: 'document.uploaded',
    targetType: 'document',
    targetId: documentId,
    actor,
    // File name is metadata the Organization already holds. The contents never appear here.
    metadata: { fileName, contentType, sizeBytes },
  });

  return { documentId, storagePath };
}

/**
 * Issues a short-lived signed URL for a Document.
 *
 * The URL is created with the caller's own client, so storage policies decide whether it may
 * exist at all — a cross-tenant request is refused before any URL is minted. The result is
 * returned and never written to a row, a log, or the audit trail.
 */
export async function createDocumentDownloadUrl(
  client: DbClient,
  documentId: string,
  options?: { download?: boolean },
): Promise<string> {
  const { data: document, error } = await client
    .from('documents')
    .select('storage_path')
    .eq('id', documentId)
    .maybeSingle();

  if (error) throw new Error(`Could not read document: ${error.message}`);
  if (!document) throw new Error('No such document');

  const { data, error: signError } = await client.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .createSignedUrl(document.storage_path, SIGNED_URL_TTL_SECONDS, { download: options?.download });

  if (signError || !data) {
    throw new Error(`Could not sign document URL: ${signError?.message ?? 'refused'}`);
  }

  return data.signedUrl;
}

export interface CaseDocumentForDownload {
  readonly documentId: string;
  readonly storagePath: string;
  readonly fileName: string;
  readonly participantName: string;
  readonly requirementLabel: string;
}

/**
 * The latest Document for every participant Requirement in a Case, for the "Descargar todo" batch
 * export. Runs as the caller's own client, so RLS scopes it to the caller's Organization exactly
 * like every other read here — a staff member never sees another Organization's Case this way.
 */
export async function getCaseDocumentsForDownload(
  client: DbClient,
  caseId: string,
): Promise<CaseDocumentForDownload[]> {
  const { data, error } = await client
    .from('case_participants')
    .select(
      `client:clients(full_name),
       requirements(id, label, deleted_at, superseded_at,
         documents(id, storage_path, file_name, created_at))`,
    )
    .eq('case_id', caseId);

  if (error) throw new Error(`Could not read case documents: ${error.message}`);

  const results: CaseDocumentForDownload[] = [];
  for (const participant of data ?? []) {
    const participantName = participant.client?.full_name ?? 'Sin participante';
    for (const requirement of participant.requirements ?? []) {
      if (requirement.deleted_at || requirement.superseded_at) continue;
      const latestDocument = [...requirement.documents].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      )[0];
      if (!latestDocument) continue;

      results.push({
        documentId: latestDocument.id,
        storagePath: latestDocument.storage_path,
        fileName: latestDocument.file_name,
        participantName,
        requirementLabel: requirement.label,
      });
    }
  }
  return results;
}

/**
 * Records an approve or reject decision.
 *
 * The Requirement's own status is moved by a database trigger rather than here, so a decision
 * written by any path keeps the Requirement consistent. Prior decisions are never modified.
 */
export async function decideReview(
  client: DbClient,
  input: ReviewDecisionInput,
  actorAuthUserId: string,
): Promise<void> {
  const { documentId, decision, reason } = parseInput(reviewDecisionSchema, input);

  const { data: document, error: readError } = await client
    .from('documents')
    .select('organization_id, case_id')
    .eq('id', documentId)
    .maybeSingle();

  if (readError) throw new Error(`Could not read document: ${readError.message}`);
  if (!document) throw new Error('No such document');

  // Server-side authority for the same rule the Staff UI already enforces visually: once a Case
  // is closed, reviewing a Document is no longer a valid operation, regardless of how the call
  // arrived (a stale tab, a direct Server Action invocation, or any future caller that skips the
  // UI). close_case is the only place a Case leaves 'open', so this check can never race a
  // concurrent closure into a false negative — at worst it rejects a review that started a moment
  // before closure completed, which is the correct, conservative outcome.
  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('state')
    .eq('id', document.case_id)
    .maybeSingle();

  if (caseError) throw new Error(`Could not read case: ${caseError.message}`);
  if (!caseRow) throw new Error('No such case');
  if (caseRow.state !== 'open') throw new Error('Case is not open');

  const { error } = await client.from('reviews').insert({
    organization_id: document.organization_id,
    case_id: document.case_id,
    document_id: documentId,
    decision,
    reason: reason ?? null,
    reviewed_by_auth_user_id: actorAuthUserId,
  });

  if (error) {
    throw new Error(`Could not record review: ${error.message}`);
  }

  await recordAuditEvent(client, {
    organizationId: document.organization_id,
    caseId: document.case_id,
    action: 'review.decided',
    targetType: 'document',
    targetId: documentId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { decision },
  });
}
