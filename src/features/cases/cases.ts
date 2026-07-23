import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { parseInput } from '@/lib/validation/parse';
import { recordAuditEvent } from '@/features/audit/record';

type DbClient = SupabaseClient<Database>;

export const createCaseSchema = z.object({
  organizationId: z.string().uuid(),
  clientId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  blueprintId: z.string().uuid().optional(),
});

export const caseStateSchema = z.enum(['open', 'completed', 'cancelled']);

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

/**
 * Moves a Case through its lifecycle.
 *
 * Completing a Case also downgrades its active grants to view for the Organization's retention
 * window — done by a database trigger, so it happens however the state was changed.
 */
export async function setCaseState(
  client: DbClient,
  caseId: string,
  state: z.infer<typeof caseStateSchema>,
  actorAuthUserId: string,
): Promise<void> {
  const nextState = parseInput(caseStateSchema, state);

  const { data: before, error: readError } = await client
    .from('cases')
    .select('organization_id, state')
    .eq('id', caseId)
    .maybeSingle();

  if (readError) throw new Error(`Could not read case: ${readError.message}`);
  if (!before) throw new Error('No such case');

  const { error } = await client
    .from('cases')
    .update({
      state: nextState,
      completed_at: nextState === 'completed' ? new Date().toISOString() : null,
    })
    .eq('id', caseId);

  if (error) throw new Error(`Could not change case state: ${error.message}`);

  await recordAuditEvent(client, {
    organizationId: before.organization_id,
    caseId,
    action: 'case.state_changed',
    targetType: 'case',
    targetId: caseId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { from: before.state, to: nextState },
  });
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
