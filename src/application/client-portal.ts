import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { ValidationError, parseInput } from '@/lib/validation/parse';
import { UseCaseError, type FailureReason } from './errors';
import { logDomainEvent } from './events';
import {
  InvitationError,
  lookupInvitation,
  resolveMyGrant,
  sendInvitationOtp,
  verifyInvitationOtp,
  type InvitationFailure,
} from '@/features/case-access/invitations';
import { getPortalCase, type PortalRequirement } from '@/features/case-access/portal-queries';
import { createDocumentDownloadUrl, registerDocument } from '@/features/documents/documents';
import { ALLOWED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '@/features/documents/schemas';
import { CASE_DOCUMENTS_BUCKET, documentObjectPath } from '@/lib/storage/paths';
import { randomUUID } from 'node:crypto';

type DbClient = SupabaseClient<Database>;

/**
 * The Client Portal's use cases: the journey a Participant walks, end to end.
 *
 * "What do I need to do next?" is the only question this layer answers. It never returns the
 * full Case structure — only what the client's own principles require: their own Requirements,
 * pending first, with enough context to act (§ CLIENT_PORTAL.md).
 */

// Maps the invitation domain's failure reasons onto the generic ones a Server Action returns,
// so the UI's dedicated-state switch (one per FailureReason) covers the portal too.
const INVITATION_REASON: Record<InvitationFailure, FailureReason> = {
  invalid_token: 'not_found',
  already_verified: 'conflict',
  revoked: 'forbidden',
  expired: 'forbidden',
  cooldown: 'validation',
  locked: 'validation',
  invalid_code: 'validation',
};

function rethrowInvitationError(cause: unknown): never {
  if (cause instanceof InvitationError) {
    throw new UseCaseError(INVITATION_REASON[cause.reason], invitationMessage(cause.reason), undefined);
  }
  throw cause;
}

/** Client-facing copy — no internal vocabulary (Blueprint/Grant/Participant never appear). */
function invitationMessage(reason: InvitationFailure): string {
  switch (reason) {
    case 'invalid_token':
      // Covers two real cases honestly in one message: a genuinely malformed/mistyped link, and a
      // link superseded by a newer one issued after a "Recordar" click or an automatic reminder
      // (emit_participant_invitation rotates the credential, which immediately retires the old
      // hash — see supabase/migrations/20260731130000_participant_invitation_reissue.sql).
      return 'Este enlace ya no es válido. Si recibiste un correo más reciente, usa ese enlace; si no, pide a la notaría que te envíe uno nuevo.';
    case 'revoked':
      return 'Este enlace ya no está disponible. Contacta a la notaría para uno nuevo.';
    case 'expired':
      return 'Este enlace ya venció. Pide a la notaría que te envíe uno nuevo.';
    case 'cooldown':
      return 'Ya te enviamos un código. Espera un momento antes de pedir otro.';
    case 'locked':
      return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
    case 'invalid_code':
      return 'Ese código no es correcto. Revisa tu correo e inténtalo otra vez.';
    case 'already_verified':
      return 'Ya habías confirmado este acceso.';
  }
}

// ------------------------------------------------------------------------------------------------
// 1 · Resolve invitation
// ------------------------------------------------------------------------------------------------

export interface InvitationLanding {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly alreadyVerified: boolean;
}

const tokenSchema = z.object({ token: z.string().min(1) });

/** What an unauthenticated visitor sees: who is asking, and for what — nothing else. */
export async function resolveInvitation(input: { token: string }): Promise<InvitationLanding> {
  try {
    const { token } = parseInput(tokenSchema, input);
    return await lookupInvitation({ token });
  } catch (cause) {
    rethrowInvitationError(cause);
  }
}

// ------------------------------------------------------------------------------------------------
// 2 · Authenticate with OTP
// ------------------------------------------------------------------------------------------------

/** Sends the access code. A resend is the same call — retries are ordinary, not special-cased. */
export async function requestAccessCode(client: DbClient, input: { token: string }): Promise<void> {
  try {
    const { token } = parseInput(tokenSchema, input);
    await sendInvitationOtp(client, { token });
  } catch (cause) {
    rethrowInvitationError(cause);
  }
}

const verifySchema = z.object({
  token: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
});

/**
 * Exchanges the code for a session bound to this invitation's Participant.
 *
 * Returns nothing beyond success/failure — the caller re-resolves the grant via
 * {@link getPortalState} with the same token immediately after, now that a session exists. There
 * is no reason to compute the Participant id twice.
 */
export async function verifyAccessCode(client: DbClient, input: { token: string; code: string }): Promise<void> {
  let parsed;
  try {
    parsed = parseInput(verifySchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError('validation', 'Revisa el código e inténtalo de nuevo.', error.issues);
    }
    throw error;
  }

  try {
    await verifyInvitationOtp(client, parsed);
  } catch (cause) {
    rethrowInvitationError(cause);
  }
}

// ------------------------------------------------------------------------------------------------
// 3 + 4 · Resolve active grant, show pending-first
// ------------------------------------------------------------------------------------------------

export interface PortalState {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly requirements: PortalRequirement[];
  readonly pendingCount: number;
  readonly isComplete: boolean;
}

/**
 * The whole portal screen's data in one call: resolves the caller's own grant for this
 * invitation, confirms it is active, and returns their Requirements pending-first.
 *
 * A grant that exists but is not active (expired/revoked after the client already accepted it
 * once) is a dedicated state — 'forbidden' — never confused with "nothing left to do".
 */
export async function getPortalState(client: DbClient, token: string): Promise<PortalState> {
  const grant = await resolveMyGrant(client, token);
  if (!grant) {
    throw new UseCaseError('not_found', 'No encontramos tu acceso. Vuelve a intentarlo.');
  }
  if (!grant.isActive) {
    throw new UseCaseError(
      'forbidden',
      'Tu acceso a este expediente ya no está disponible. Contacta a la notaría.',
    );
  }

  const portalCase = await getPortalCase(client, grant.participantId);
  if (!portalCase) {
    throw new UseCaseError('not_found', 'No encontramos tu expediente.');
  }

  const pendingCount = portalCase.requirements.filter(
    (r) => r.state === 'pending' || r.state === 'rejected',
  ).length;

  return { ...portalCase, pendingCount, isComplete: pendingCount === 0 };
}

// ------------------------------------------------------------------------------------------------
// 5 + 7 · Upload (first time or replacing a rejected Requirement)
// ------------------------------------------------------------------------------------------------

const uploadInputSchema = z.object({
  token: z.string().min(1),
  requirementId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(500),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});

export interface UploadRequirementDocumentInput {
  readonly token: string;
  readonly requirementId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** The raw bytes. A Blob/File works directly with Supabase Storage's upload API. */
  readonly file: Blob;
}

/**
 * Uploads a document for one of the caller's own Requirements, through a signed upload URL.
 *
 * The signed URL is minted with the caller's own session, so the storage INSERT policy
 * (`granted_participant_ids('upload')` on the path's Requirement segment) decides whether this
 * write may exist at all — before a single byte moves. This is the same authorization boundary
 * as every other write in the system; a signed URL does not bypass it, it is issued by it.
 *
 * Works identically for a first upload and for replacing a rejected one: both are just "a new
 * Document for this Requirement" — the prior Document and its rejection stay in place, providing
 * the history a Staff member can review later.
 */
export async function uploadRequirementDocument(
  client: DbClient,
  input: UploadRequirementDocumentInput,
  actorAuthUserId: string,
): Promise<void> {
  let parsed;
  try {
    parsed = parseInput(uploadInputSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError('validation', 'Revisa el archivo: solo PDF o imágenes de hasta 25 MB.', error.issues);
    }
    throw error;
  }

  const grant = await resolveMyGrant(client, parsed.token);
  if (!grant || !grant.isActive) {
    throw new UseCaseError('forbidden', 'Tu acceso a este expediente ya no está disponible.');
  }
  if (grant.permission !== 'upload') {
    throw new UseCaseError('forbidden', 'No puedes subir documentos en este momento.');
  }

  const { data: requirement, error: reqError } = await client
    .from('requirements')
    .select('organization_id, case_id, participant_id, status')
    .eq('id', parsed.requirementId)
    .maybeSingle();

  if (reqError) throw new UseCaseError('unexpected', 'No pudimos leer ese requisito.');
  if (!requirement || requirement.participant_id !== grant.participantId) {
    throw new UseCaseError('not_found', 'Ese requisito ya no está disponible para ti.');
  }
  // An approved Requirement is read-only from the Portal — re-uploading would silently reopen a
  // decision the client never sees change (deriveState in portal-queries.ts trusts `status` first,
  // so the checklist would keep showing "Aprobado" while a brand-new, unreviewed Document sat
  // underneath it). Reversing an approval is Staff's call, not a side effect of a client's upload.
  if (requirement.status === 'satisfied') {
    throw new UseCaseError('conflict', 'Este requisito ya fue aprobado y no se puede reemplazar.');
  }

  const documentId = randomUUID();
  const path = documentObjectPath({
    organizationId: requirement.organization_id,
    caseId: requirement.case_id,
    requirementId: parsed.requirementId,
    documentId,
  });

  const { data: signed, error: signError } = await client.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(path);

  if (signError || !signed) {
    throw new UseCaseError('forbidden', 'No pudimos preparar la subida. Intenta de nuevo.');
  }

  const { error: uploadError } = await client.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .uploadToSignedUrl(path, signed.token, input.file, { contentType: parsed.contentType });

  if (uploadError) {
    throw new UseCaseError('delivery_failed', 'No pudimos subir el archivo. Vuelve a intentarlo.');
  }

  try {
    await registerDocument(
      client,
      {
        organizationId: requirement.organization_id,
        caseId: requirement.case_id,
        requirementId: parsed.requirementId,
        fileName: parsed.fileName,
        contentType: parsed.contentType,
        sizeBytes: parsed.sizeBytes,
        documentId,
      },
      { kind: 'client', authUserId: actorAuthUserId, grantId: grant.grantId },
    );
  } catch (cause) {
    console.error('Document uploaded to storage but registerDocument failed:', cause);
    throw new UseCaseError('unexpected', 'El archivo se subió, pero no pudimos registrarlo. Contacta a la notaría.');
  }

  await logDomainEvent(client, {
    organizationId: requirement.organization_id,
    caseId: requirement.case_id,
    action: 'document.uploaded',
    targetType: 'requirement',
    targetId: parsed.requirementId,
    actor: { kind: 'client', authUserId: actorAuthUserId, grantId: grant.grantId },
    metadata: { replaced: true },
  });
}

// ------------------------------------------------------------------------------------------------
// 8 · View/download a Document the client submitted themselves
// ------------------------------------------------------------------------------------------------

const documentUrlSchema = z.object({
  token: z.string().min(1),
  documentId: z.string().uuid(),
});

/**
 * Signs a short-lived URL for one of the caller's own submitted Documents — reachable whether the
 * underlying Requirement is still pending review or already approved (design.md: approved
 * Documents stay visible, they just become read-only).
 *
 * Ownership is checked explicitly, the same defense-in-depth style as uploadRequirementDocument's
 * own participant check: RLS on `documents`/`storage.objects` (granted_participant_ids) would
 * refuse a cross-participant id on its own, but this call fails with a clear, dedicated message
 * rather than a bare storage 404 if the id belongs to someone else's Requirement.
 */
export async function getClientDocumentUrl(
  client: DbClient,
  input: { token: string; documentId: string; download?: boolean },
): Promise<string> {
  let parsed;
  try {
    parsed = parseInput(documentUrlSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError('validation', 'Solicitud inválida.', error.issues);
    }
    throw error;
  }

  const grant = await resolveMyGrant(client, parsed.token);
  if (!grant || !grant.isActive) {
    throw new UseCaseError('forbidden', 'Tu acceso a este expediente ya no está disponible.');
  }

  const { data: document, error: documentError } = await client
    .from('documents')
    .select('requirement:requirements(participant_id)')
    .eq('id', parsed.documentId)
    .maybeSingle();

  if (documentError) throw new UseCaseError('unexpected', 'No pudimos leer ese documento.');
  if (!document?.requirement || document.requirement.participant_id !== grant.participantId) {
    throw new UseCaseError('not_found', 'Ese documento ya no está disponible para ti.');
  }

  try {
    return await createDocumentDownloadUrl(client, parsed.documentId, { download: input.download });
  } catch {
    throw new UseCaseError('unexpected', 'No pudimos generar el enlace. Intenta de nuevo.');
  }
}
