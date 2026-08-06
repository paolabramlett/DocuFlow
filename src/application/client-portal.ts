import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { ValidationError, parseInput } from '@/lib/validation/parse';
import { UseCaseError, type FailureReason } from './errors';
import {
  InvitationError,
  lookupInvitation,
  resolveMyGrant,
  sendInvitationOtp,
  verifyInvitationOtp,
  type InvitationFailure,
} from '@/features/case-access/invitations';
import { getPortalCase, type PortalRequirement } from '@/features/case-access/portal-queries';
import { createDocumentDownloadUrl } from '@/features/documents/documents';
import { ALLOWED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from '@/features/documents/schemas';
import { CASE_DOCUMENTS_BUCKET } from '@/lib/storage/paths';

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
  readonly caseState: 'open' | 'completed' | 'cancelled';
  readonly clientClosingNote?: string;
  readonly requirements: PortalRequirement[];
  readonly pendingCount: number;
  readonly isComplete: boolean;
  /** Reopened Requirements from an already-completed stage that still need a correction — kept
   *  distinct from the ordinary pending list so the client understands these are re-dos, not new
   *  asks (docs/CLIENT_PORTAL.md §5). */
  readonly correctionsPending: PortalRequirement[];
  /** Per §5: every stage completed, no reopened-pending, no unassigned-pending. Mirrors
   *  workflowDocumentationComplete's Staff-side definition (src/features/cases/queries.ts), but
   *  derived independently here since the Portal never receives a stages[] array to check against
   *  directly — only whether any visible Requirement still carries a stage at all. */
  readonly workflowComplete: boolean;
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

  const correctionsPending = portalCase.requirements.filter(
    (r) => r.reopenedFromRequirementId !== null && (r.state === 'pending' || r.state === 'rejected'),
  );
  const activeStateItems = portalCase.requirements.filter(
    (r) => r.reopenedFromRequirementId === null && (r.state === 'pending' || r.state === 'rejected'),
  );
  const pendingCount = correctionsPending.length + activeStateItems.length;
  const hasWorkflow = portalCase.requirements.some((r) => r.stageStatus !== undefined);
  const workflowComplete = hasWorkflow && pendingCount === 0;

  return {
    ...portalCase,
    pendingCount,
    isComplete: pendingCount === 0,
    correctionsPending,
    workflowComplete,
  };
}

// ------------------------------------------------------------------------------------------------
// 6 · Prepare an upload session (Step 1 of prepare/upload/finalize)
// ------------------------------------------------------------------------------------------------

const prepareUploadInputSchema = z.object({
  token: z.string().min(1),
  requirementId: z.string().uuid(),
  fileName: z.string().trim().min(1).max(500),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
  sizeBytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
});

export interface PrepareUploadInput {
  readonly token: string;
  readonly requirementId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface PrepareUploadResult {
  readonly sessionId: string;
  readonly signedUrl: string;
  readonly token: string;
  readonly path: string;
}

const CREATE_UPLOAD_SESSION_MESSAGES: Record<string, string> = {
  requirement_not_found: 'Ese requisito ya no está disponible para ti.',
  requirement_already_satisfied: 'Este requisito ya fue aprobado y no se puede reemplazar.',
  file_too_large: 'El archivo es demasiado grande. El límite es 25 MB.',
  content_type_not_allowed: 'Ese tipo de archivo no está permitido. Sube un PDF o una imagen.',
};

function mapCreateUploadSessionError(error: { message: string }): UseCaseError {
  const message = CREATE_UPLOAD_SESSION_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos preparar la subida. Intenta de nuevo.');
  const reason = error.message === 'requirement_not_found' ? 'not_found' : 'conflict';
  return new UseCaseError(reason, message);
}

/**
 * Step 1 of the prepare/upload/finalize flow (design.md, portal-upload-progress). Validates the
 * grant/permission up front for a fast, friendly error, then delegates the actual session
 * creation to create_upload_session (Task 1) — a security definer RPC, never a raw `.insert()` on
 * document_upload_sessions (there is no insert RLS policy for any client role; creation is fully
 * server-encapsulated, exactly like every state transition already is). The RPC re-validates the
 * requirement/participant/size/content-type itself, so this function's own checks are a UX
 * fast-path, not the actual security boundary — the same "don't trust a single layer" pattern
 * this codebase already uses (schemas.ts's own doc comment on ALLOWED_CONTENT_TYPES/
 * MAX_DOCUMENT_BYTES: "two enforcement points on purpose").
 *
 * create_upload_session itself now generates reserved_document_id/storage_path server-side (Task
 * 1's own review found the original client-generates-then-passes-in design let a caller supply an
 * arbitrary storage_path or collide reserved_document_id with someone else's documents.id) — so
 * this function passes only the 5 declarative fields and uses the RPC's own returned storage_path
 * as the path it mints the signed URL for, never a value it computed itself.
 *
 * Reserves the session row FIRST, then mints the signed upload URL — never the reverse order,
 * which would leave a valid upload credential with no internal record if minting failed after the
 * row existed. If minting fails, the session is cancelled via cancel_upload_session (Task 4) —
 * not a raw `.update()`, for the same reason creation itself isn't a raw `.insert()`.
 */
export async function prepareUpload(client: DbClient, input: PrepareUploadInput): Promise<PrepareUploadResult> {
  let parsed;
  try {
    parsed = parseInput(prepareUploadInputSchema, input);
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
  if (requirement.status === 'satisfied') {
    throw new UseCaseError('conflict', 'Este requisito ya fue aprobado y no se puede reemplazar.');
  }

  const signedUrlExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const { data: created, error: createError } = await client.rpc('create_upload_session', {
    p_requirement_id: parsed.requirementId,
    p_original_file_name: parsed.fileName,
    p_declared_content_type: parsed.contentType,
    p_declared_size_bytes: parsed.sizeBytes,
    p_signed_url_expires_at: signedUrlExpiresAt,
  });

  // The Supabase client surfaces a `returns table (...)` RPC as an array of rows, even for a
  // single-row result — confirmed empirically against the local RPC, not assumed from the SQL
  // signature alone.
  const session = created?.[0];

  if (createError || !session) {
    throw mapCreateUploadSessionError(createError ?? { message: '' });
  }

  const { sessionId, storagePath } = { sessionId: session.session_id, storagePath: session.storage_path };

  const { data: signed, error: signError } = await client.storage
    .from(CASE_DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (signError || !signed) {
    // The row exists but the credential never did — cancel it via the same RPC every other
    // pending->cancelled transition uses, rather than a raw update, for the same "no direct
    // writes from client code" reasoning as creation itself.
    await client.rpc('cancel_upload_session', { p_session_id: sessionId });
    throw new UseCaseError('forbidden', 'No pudimos preparar la subida. Intenta de nuevo.');
  }

  return { sessionId, signedUrl: signed.signedUrl, token: signed.token, path: storagePath };
}

// ------------------------------------------------------------------------------------------------
// 7 · Finalize / cancel an upload session (Steps 3 and cancel-path of prepare/upload/finalize)
// ------------------------------------------------------------------------------------------------

// No 'not_authorized' key: RLS on document_upload_sessions already scopes every read to the
// caller's own participant_id, so an inaccessible session is indistinguishable from a
// nonexistent one at the RPC layer (upload_session_not_found covers both) — see Task 2's
// claim_upload_session_for_finalize RPC comment for the full reasoning, matching this codebase's
// established getPortalCase precedent.
const UPLOAD_SESSION_MESSAGES: Record<string, string> = {
  upload_session_not_found: 'Esa sesión de subida ya no existe.',
  upload_finalize_in_progress: 'Estamos confirmando tu archivo, intenta de nuevo en unos segundos.',
  upload_session_cancelled: 'Esta subida fue cancelada. Selecciona el archivo de nuevo.',
  upload_session_expired: 'Esta subida expiró. Selecciona el archivo de nuevo.',
  upload_session_not_finalizing: 'Esta subida ya no está en curso.',
  requirement_already_satisfied: 'Este requisito ya fue aprobado y no se puede reemplazar.',
  grant_no_longer_active: 'Tu acceso a este expediente ya no está disponible.',
  case_not_open: 'Este expediente ya no está abierto.',
  upload_already_completed: 'Esta subida ya se completó.',
  content_type_mismatch: 'El archivo subido no coincide con lo esperado. Intenta de nuevo.',
};

function mapUploadSessionError(error: { message: string }): UseCaseError {
  const message = UPLOAD_SESSION_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos procesar la subida. Intenta de nuevo.');
  const reason =
    error.message === 'upload_session_not_found' ? 'not_found'
    : error.message === 'requirement_already_satisfied' ? 'conflict'
    : error.message === 'content_type_mismatch' ? 'validation'
    : 'conflict';
  return new UseCaseError(reason, message);
}

/**
 * Step 3 of the prepare/upload/finalize flow. Calls claim_upload_session_for_finalize FIRST — if
 * the session is already completed, this returns immediately without ever calling Storage.info().
 * Only when not already completed does it inspect the real uploaded object and call
 * finalize_document_upload with the VERIFIED (not declared) size/content-type.
 */
export async function finalizeUpload(client: DbClient, sessionId: string): Promise<string> {
  const { data: claimed, error: claimError } = await client
    .rpc('claim_upload_session_for_finalize', { p_session_id: sessionId })
    .single();
  if (claimError) throw mapUploadSessionError(claimError);
  if (claimed.already_completed) return claimed.completed_document_id!;

  const { data: session, error: readError } = await client
    .from('document_upload_sessions')
    .select('bucket, storage_path, declared_size_bytes, declared_content_type')
    .eq('id', sessionId)
    .single();
  if (readError || !session) {
    throw new UseCaseError('unexpected', 'No pudimos confirmar la subida. Intenta de nuevo.');
  }

  const { data: info, error: infoError } = await client.storage.from(session.bucket).info(session.storage_path);
  if (infoError || !info) {
    throw new UseCaseError('unexpected', 'No encontramos el archivo subido. Intenta de nuevo.');
  }
  if (info.size == null || info.size <= 0 || info.size !== session.declared_size_bytes) {
    throw new UseCaseError('validation', 'El archivo subido no coincide con lo esperado. Intenta de nuevo.');
  }
  if (!info.contentType || info.contentType !== session.declared_content_type) {
    throw new UseCaseError('validation', 'El archivo subido no coincide con lo esperado. Intenta de nuevo.');
  }

  const { data: documentId, error: finalizeError } = await client.rpc('finalize_document_upload', {
    p_session_id: sessionId,
    p_verified_size_bytes: info.size,
    p_verified_content_type: info.contentType,
  });
  if (finalizeError) throw mapUploadSessionError(finalizeError);

  return documentId!;
}

/**
 * Cancels a pending upload session and best-effort deletes its Storage object. The RPC
 * (cancel_upload_session, Task 4) is the actual state transition; the Storage delete afterward is
 * cleanup, not the source of truth — a failure to delete the object is logged but never surfaces
 * to the caller, since the session itself is already correctly cancelled either way and a later
 * cleanup job can still reclaim the orphaned object.
 *
 * That "later cleanup job" is not a rare fallback here — it is, in practice, the ONLY path that
 * actually removes the object for a real Participant caller. `client` runs as the Participant
 * under RLS, and case_documents_delete_by_member (supabase/migrations/20260722194115_storage_buckets.sql)
 * grants delete on storage.objects to Organization members only, by explicit design ("Clients
 * never update or delete: a document they replace is a new upload plus a new Review, which keeps
 * the history intact" — that migration's own comment). Confirmed empirically while writing this
 * function: `.remove()` here does not error for a Participant caller, it just deletes zero rows
 * (`{ data: [], error: null }`) — RLS silently filters the target out rather than surfacing a
 * failure. This call is kept anyway (harmless, and does work for the rarer case of a caller that
 * happens to hold elevated rights) but the object's guaranteed eventual removal is the async
 * Storage-deletion step described in supabase/migrations/20260805170400_upload_session_cleanup.sql's
 * own header comment (a separate, privileged Edge Function on a cron cadence), not this line.
 */
export async function cancelUploadSession(client: DbClient, sessionId: string): Promise<void> {
  const { data: session } = await client
    .from('document_upload_sessions')
    .select('bucket, storage_path')
    .eq('id', sessionId)
    .maybeSingle();

  const { error } = await client.rpc('cancel_upload_session', { p_session_id: sessionId });
  if (error) throw mapUploadSessionError(error);

  if (session) {
    try {
      await client.storage.from(session.bucket).remove([session.storage_path]);
    } catch (cause) {
      console.error("Failed to delete a cancelled upload session's Storage object", { sessionId, cause });
    }
  }
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
 * Ownership is checked explicitly, the same defense-in-depth style as prepareUpload's own
 * participant check (`requirement.participant_id !== grant.participantId`): RLS on
 * `documents`/`storage.objects` (granted_participant_ids) would
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
