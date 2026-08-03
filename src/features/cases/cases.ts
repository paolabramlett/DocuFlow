import type { SupabaseClient, PostgrestError } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { parseInput } from '@/lib/validation/parse';
import { recordAuditEvent } from '@/features/audit/record';
import { UseCaseError } from '@/application/errors';
import { reissueParticipantInvitation } from '@/features/case-access/invitations';
import { sendTransactionalEmail, type SendTransactionalEmailInput } from '@/lib/email/resend';
import { escapeHtml } from '@/lib/email/escape-html';
import { APP_ORIGIN } from '@/lib/supabase/env';

type DbClient = SupabaseClient<Database>;

export const createCaseSchema = z.object({
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  blueprintId: z.string().uuid().optional(),
});

export const addRequirementSchema = z.object({
  organizationId: z.string().uuid(),
  caseId: z.string().uuid(),
  label: z.string().trim().min(1).max(300),
  instructions: z.string().trim().max(4000).optional(),
  position: z.number().int().min(0),
  // Null/absent = Case-level, Staff-only (design.md D2).
  participantId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  // Only `document` is accepted. The database refuses the other planned types too, so this is
  // the friendly rejection rather than the only one.
  type: z.literal('document').default('document'),
});

export const supersedeRequirementSchema = z.object({
  requirementId: z.string().uuid(),
  label: z.string().trim().min(1).max(300),
  instructions: z.string().trim().max(4000).optional(),
});

export const renameRequirementSchema = z.object({
  requirementId: z.string().uuid(),
  label: z.string().trim().min(1).max(300),
});

export const reorderRequirementsSchema = z.object({
  caseId: z.string().uuid(),
  orderedRequirementIds: z.array(z.string().uuid()).min(1),
});

/**
 * Creates a Case, optionally cloning a Blueprint.
 *
 * The clone itself happens in `public.create_case`, which copies definitions inside one
 * transaction so a Case is never half-populated.
 */
export async function createCase(
  client: DbClient,
  input: z.input<typeof createCaseSchema>,
  actorAuthUserId: string,
): Promise<string> {
  const { organizationId, clientId, title, blueprintId } = parseInput(createCaseSchema, input);

  const { data: caseId, error } = await client.rpc('create_case', {
    target_organization_id: organizationId,
    target_client_id: clientId,
    case_title: title,
    from_blueprint_id: blueprintId ?? undefined,
  });

  if (error || !caseId) {
    throw new Error(`Could not create case: ${error?.message ?? 'no id returned'}`);
  }

  await recordAuditEvent(client, {
    organizationId,
    caseId,
    action: 'case.created',
    targetType: 'case',
    targetId: caseId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { fromBlueprint: blueprintId !== undefined },
  });

  return caseId;
}

const CLOSE_CASE_MESSAGES: Record<string, string> = {
  invalid_outcome: 'Resultado de cierre no válido.',
  case_not_found: 'El expediente ya no existe.',
  case_not_open: 'Este expediente ya no está abierto.',
  documentation_incomplete: 'No se puede marcar como completado: aún hay documentación pendiente.',
  cancellation_note_required: 'Escribe el motivo de cancelación que verá el cliente.',
  not_authorized: 'No tienes permiso para cerrar este expediente.',
};

function mapCloseCaseError(error: PostgrestError): UseCaseError {
  const message = CLOSE_CASE_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos cerrar el expediente. Intenta de nuevo.');
  const reason =
    error.message === 'documentation_incomplete' || error.message === 'cancellation_note_required'
      ? 'validation'
      : error.message === 'not_authorized'
        ? 'forbidden'
        : 'conflict';
  return new UseCaseError(reason, message);
}

const REOPEN_CASE_MESSAGES: Record<string, string> = {
  case_not_found: 'El expediente ya no existe.',
  case_not_terminal: 'Este expediente no está cerrado.',
  not_authorized: 'No tienes permiso para reabrir este expediente.',
};

function mapReopenCaseError(error: PostgrestError): UseCaseError {
  const message = REOPEN_CASE_MESSAGES[error.message];
  if (!message) return new UseCaseError('unexpected', 'No pudimos reabrir el expediente. Intenta de nuevo.');
  const reason =
    error.message === 'case_not_found' ? 'not_found' : error.message === 'not_authorized' ? 'forbidden' : 'conflict';
  return new UseCaseError(reason, message);
}

interface CaseAndOrgName {
  readonly title: string;
  readonly organizationName: string;
}

async function readCaseAndOrgName(client: DbClient, caseId: string): Promise<CaseAndOrgName> {
  const { data } = await client
    .from('cases')
    .select('title, organization:organizations(name)')
    .eq('id', caseId)
    .single();
  return { title: data?.title ?? '', organizationName: data?.organization?.name ?? 'Avanza' };
}

/** One row per Participant with an active grant on this Case, deduplicated — never one per grant
 *  row, matching the exact rationale in reopen_case's own contract (Task 3). "Active" here matches
 *  the canonical predicate used everywhere else in this codebase (app.granted_participant_ids, the
 *  case-closure grant trigger, and reopen_case itself): verified, not revoked, and not expired —
 *  not merely "not revoked and not permission 'none'". */
async function activeGrantParticipants(
  client: DbClient,
  caseId: string,
): Promise<{ participantId: string; invitedEmail: string }[]> {
  const { data } = await client
    .from('case_access_grants')
    .select('participant_id, invited_email, revoked_at, permission, verified_at, expires_at')
    .eq('case_id', caseId);

  const now = Date.now();
  const seen = new Set<string>();
  const result: { participantId: string; invitedEmail: string }[] = [];
  for (const g of data ?? []) {
    if (g.revoked_at !== null || g.permission === 'none') continue;
    if (g.verified_at === null) continue;
    if (g.expires_at === null || Date.parse(g.expires_at) <= now) continue;
    if (seen.has(g.participant_id)) continue;
    seen.add(g.participant_id);
    result.push({ participantId: g.participant_id, invitedEmail: g.invited_email });
  }
  return result;
}

async function notifyParticipantsOfClosure(
  client: DbClient,
  caseId: string,
  outcome: 'completed' | 'cancelled',
  closingNote: string | undefined,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<void> {
  try {
    const { title, organizationName } = await readCaseAndOrgName(client, caseId);
    const participants = await activeGrantParticipants(client, caseId);
    const safeTitle = escapeHtml(title);
    const noteHtml = closingNote
      ? `<p><strong>Motivo:</strong> ${escapeHtml(closingNote)}</p>`
      : '';
    const heading = outcome === 'completed' ? 'Expediente completado' : 'Expediente cancelado';
    const body =
      outcome === 'completed'
        ? `Tu expediente <strong>${safeTitle}</strong> fue completado. Toda tu documentación requerida fue aprobada.`
        : `Tu expediente <strong>${safeTitle}</strong> fue cancelado.`;

    for (const p of participants) {
      await sendEmail({
        to: p.invitedEmail,
        subject: `${heading} — ${organizationName}`,
        html: `<h2>${heading}</h2>\n<p>${body}</p>\n${noteHtml}`,
        idempotencyKey: `case-closure/${caseId}/${p.participantId}/${outcome}/${Date.now()}`,
      });
    }
  } catch (cause) {
    console.error('Failed to notify participants of case closure', { caseId, outcome, cause });
  }
}

async function notifyParticipantsOfReopening(
  client: DbClient,
  caseId: string,
  restoredParticipantIds: string[],
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<number> {
  let failureCount = 0;
  try {
    const { title, organizationName } = await readCaseAndOrgName(client, caseId);
    const safeTitle = escapeHtml(title);
    for (const participantId of restoredParticipantIds) {
      // Each Participant's (reissue + send) pair gets its own try/catch — a failure for one
      // Participant must never stop the loop from reaching the rest. Note reissuing rotates the
      // token hash immediately (destroying the old link) before sendEmail runs, so a failure here
      // means that Participant's old link is gone and the new one was never delivered; the caller
      // surfaces failureCount so Staff can use "Recordar" to retry.
      try {
        // One reissue per restored Participant, never per grant row — a second reissue for the
        // same Participant would invalidate the token this same loop just minted for them.
        const reissued = await reissueParticipantInvitation(client, participantId);
        await sendEmail({
          to: reissued.invitedEmail,
          subject: `Tu expediente fue reabierto — ${organizationName}`,
          html: `<h2>Tu expediente fue reabierto</h2>\n<p>Puedes volver a <strong>${safeTitle}</strong> para continuar.</p>\n<p><a href="${APP_ORIGIN}/portal/${reissued.token}">Ir a mi expediente</a></p>`,
          idempotencyKey: `case-reopen/${caseId}/${participantId}/${Date.now()}`,
        });
      } catch (cause) {
        failureCount += 1;
        console.error('Failed to notify a participant of case reopening', { caseId, participantId, cause });
      }
    }
  } catch (cause) {
    console.error('Failed to notify participants of case reopening', { caseId, cause });
    failureCount = restoredParticipantIds.length;
  }
  return failureCount;
}

/**
 * Closes a Case as completed (documentation fully approved) or cancelled (any time, with a
 * client-visible note). All validation and the state change happen atomically inside the
 * close_case RPC (Task 2) — this function only calls it and, on success, sends a best-effort
 * notification. Never calls recordAuditEvent: the audit event is already written, atomically,
 * inside the RPC itself.
 */
export async function closeCase(
  client: DbClient,
  caseId: string,
  outcome: 'completed' | 'cancelled',
  closingNote: string | undefined,
): Promise<void> {
  const { error } = await client.rpc('close_case', {
    p_case_id: caseId,
    p_outcome: outcome,
    p_closing_note: closingNote,
  });
  if (error) throw mapCloseCaseError(error);

  await notifyParticipantsOfClosure(client, caseId, outcome, closingNote);
}

/**
 * Reopens a closed Case. Ordering invariant: `reopen_case` is awaited (its transaction has
 * already committed) BEFORE any Portal token is reissued or any email sent — a fresh link is
 * never minted ahead of, or independently of, a successful reopen.
 */
export async function reopenCase(
  client: DbClient,
  caseId: string,
): Promise<{ restoredParticipantIds: string[]; requiresReinvitation: boolean; notificationFailureCount: number }> {
  const { data, error } = await client.rpc('reopen_case', { p_case_id: caseId });
  if (error) throw mapReopenCaseError(error);

  const restoredParticipantIds = (data ?? []).map((r) => r.participant_id);

  let notificationFailureCount = 0;
  if (restoredParticipantIds.length > 0) {
    notificationFailureCount = await notifyParticipantsOfReopening(client, caseId, restoredParticipantIds);
  }

  return {
    restoredParticipantIds,
    requiresReinvitation: restoredParticipantIds.length === 0,
    notificationFailureCount,
  };
}

export async function addRequirement(
  client: DbClient,
  input: z.input<typeof addRequirementSchema>,
  actorAuthUserId: string,
): Promise<string> {
  const parsed = parseInput(addRequirementSchema, input);

  const { data, error } = await client
    .from('requirements')
    .insert({
      organization_id: parsed.organizationId,
      case_id: parsed.caseId,
      type: parsed.type,
      label: parsed.label,
      instructions: parsed.instructions ?? null,
      position: parsed.position,
      participant_id: parsed.participantId ?? null,
      stage_id: parsed.stageId ?? null,
    })
    .select('id')
    .single();

  if (error || !data) throw new Error(`Could not add requirement: ${error?.message}`);

  await recordAuditEvent(client, {
    organizationId: parsed.organizationId,
    caseId: parsed.caseId,
    action: 'requirement.added',
    targetType: 'requirement',
    targetId: data.id,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { label: parsed.label, type: parsed.type },
  });

  return data.id;
}

export async function renameRequirement(
  client: DbClient,
  input: z.input<typeof renameRequirementSchema>,
  actorAuthUserId: string,
): Promise<void> {
  const { requirementId, label } = parseInput(renameRequirementSchema, input);

  const { data, error } = await client
    .from('requirements')
    .update({ label })
    .eq('id', requirementId)
    .select('organization_id, case_id')
    .maybeSingle();

  if (error) throw new Error(`Could not rename requirement: ${error.message}`);
  if (!data) throw new Error('No such requirement');

  await recordAuditEvent(client, {
    organizationId: data.organization_id,
    caseId: data.case_id,
    action: 'requirement.renamed',
    targetType: 'requirement',
    targetId: requirementId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { label },
  });
}

/**
 * Soft-deletes a Requirement.
 *
 * The row stays so its history remains readable; the active-requirements view is what hides it.
 * The audit event carries a label snapshot so the trail still reads sensibly once the Case has
 * moved on.
 */
export async function deleteRequirement(
  client: DbClient,
  requirementId: string,
  actorAuthUserId: string,
): Promise<void> {
  const { data, error } = await client
    .from('requirements')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', requirementId)
    .select('organization_id, case_id, label')
    .maybeSingle();

  if (error) throw new Error(`Could not delete requirement: ${error.message}`);
  if (!data) throw new Error('No such requirement');

  await recordAuditEvent(client, {
    organizationId: data.organization_id,
    caseId: data.case_id,
    action: 'requirement.deleted',
    targetType: 'requirement',
    targetId: requirementId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { label: data.label },
  });
}

export async function reorderRequirements(
  client: DbClient,
  input: z.input<typeof reorderRequirementsSchema>,
  actorAuthUserId: string,
): Promise<void> {
  const { caseId, orderedRequirementIds } = parseInput(reorderRequirementsSchema, input);

  const { data: caseRow, error: caseError } = await client
    .from('cases')
    .select('organization_id')
    .eq('id', caseId)
    .maybeSingle();

  if (caseError) throw new Error(`Could not read case: ${caseError.message}`);
  if (!caseRow) throw new Error('No such case');

  for (const [position, requirementId] of orderedRequirementIds.entries()) {
    const { error } = await client
      .from('requirements')
      .update({ position })
      .eq('id', requirementId)
      .eq('case_id', caseId);

    if (error) throw new Error(`Could not reorder requirements: ${error.message}`);
  }

  await recordAuditEvent(client, {
    organizationId: caseRow.organization_id,
    caseId,
    action: 'requirement.reordered',
    targetType: 'case',
    targetId: caseId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { count: orderedRequirementIds.length },
  });
}

/**
 * Supersedes a Requirement: archives the original and creates a successor carrying the new ask
 * (design.md D7).
 *
 * This is the material-change path. A satisfied Requirement is never mutated in place — its
 * Documents and Reviews stay linked to the original, which is archived with an explicit pointer
 * to its successor, and the audit records the relationship. Cosmetic edits use `renameRequirement`
 * instead and stay in place.
 *
 * The database guards the mechanics: the successor is a Requirement of the same Case (composite
 * FK), never the original itself (check constraint).
 */
export async function supersedeRequirement(
  client: DbClient,
  input: z.input<typeof supersedeRequirementSchema>,
  actorAuthUserId: string,
): Promise<string> {
  const { requirementId, label, instructions } = parseInput(supersedeRequirementSchema, input);

  const { data: original, error: readError } = await client
    .from('requirements')
    .select('organization_id, case_id, participant_id, stage_id, position, type')
    .eq('id', requirementId)
    .maybeSingle();

  if (readError) throw new Error(`Could not read requirement: ${readError.message}`);
  if (!original) throw new Error('No such requirement');

  // The successor inherits placement (participant, stage, position) and starts outstanding.
  const { data: successor, error: insertError } = await client
    .from('requirements')
    .insert({
      organization_id: original.organization_id,
      case_id: original.case_id,
      participant_id: original.participant_id,
      stage_id: original.stage_id,
      position: original.position,
      type: original.type,
      label,
      instructions: instructions ?? null,
    })
    .select('id')
    .single();

  if (insertError || !successor) {
    throw new Error(`Could not create successor requirement: ${insertError?.message}`);
  }

  // Archive the original and point it at its successor. Its Documents and Reviews are untouched.
  const { error: archiveError } = await client
    .from('requirements')
    .update({
      status: 'archived',
      superseded_at: new Date().toISOString(),
      superseded_by_requirement_id: successor.id,
    })
    .eq('id', requirementId);

  if (archiveError) {
    throw new Error(`Could not archive superseded requirement: ${archiveError.message}`);
  }

  await recordAuditEvent(client, {
    organizationId: original.organization_id,
    caseId: original.case_id,
    action: 'requirement.superseded',
    targetType: 'requirement',
    targetId: requirementId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { supersededBy: successor.id, newLabel: label },
  });

  return successor.id;
}
