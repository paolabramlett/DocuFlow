import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && SLUG_PATTERN.test(value);
}

export interface BlueprintSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly isPlatformTemplate: boolean;
  readonly stageCount: number;
  readonly participantTemplateCount: number;
  readonly caseRequirementCount: number;
  readonly participantRequirementCount: number;
}

interface RawBlueprintSummaryRow {
  id: string;
  name: string;
  description: string | null;
  is_platform_template: boolean;
  requirement_definitions: unknown;
  blueprint_stages: { id: string }[] | null;
  blueprint_participant_templates: { id: string }[] | null;
}

/**
 * Lightweight Blueprint cards for a list — Plantillas and the Create Case wizard's Step 0.
 *
 * Tolerant of malformed requirement_definitions: a bad entry elsewhere must never break the whole
 * list. Missing `scope` counts as `'case'` (matches create_case's own default); anything else
 * unreadable is simply not counted — never thrown, never guessed into a bucket.
 */
export async function listBlueprintSummaries(
  client: DbClient,
  organizationId: string,
): Promise<BlueprintSummary[]> {
  const { data, error } = await client
    .from('blueprints')
    .select(
      'id, name, description, is_platform_template, requirement_definitions, blueprint_stages(id), blueprint_participant_templates(id)',
    )
    .eq('organization_id', organizationId)
    .order('name')
    .limit(200);

  if (error) {
    // Permission denied returns empty array; other errors throw — matches getClientsDirectory.
    if (error.code === '42501') return [];
    throw new Error(`listBlueprintSummaries: ${error.message}`);
  }

  return ((data ?? []) as RawBlueprintSummaryRow[]).map((row) => {
    let caseRequirementCount = 0;
    let participantRequirementCount = 0;

    const definitions = Array.isArray(row.requirement_definitions) ? row.requirement_definitions : [];
    for (const raw of definitions) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const def = raw as Record<string, unknown>;
      const scope = def.scope ?? 'case';
      if (scope === 'case') caseRequirementCount += 1;
      else if (scope === 'participant') participantRequirementCount += 1;
      // any other value: not counted at all
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isPlatformTemplate: row.is_platform_template,
      stageCount: (row.blueprint_stages ?? []).length,
      participantTemplateCount: (row.blueprint_participant_templates ?? []).length,
      caseRequirementCount,
      participantRequirementCount,
    };
  });
}

export interface BlueprintStage {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

export interface BlueprintParticipantTemplate {
  readonly id: string;
  readonly roleKey: string;
  readonly displayName: string;
  readonly position: number;
}

export type BlueprintRequirementScope = 'case' | 'participant';

export interface BlueprintRequirementDefinition {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  readonly instructions: string | null;
  readonly scope: BlueprintRequirementScope;
  readonly participantRoleKey: string | null;
  readonly stagePosition: number | null;
}

export interface BlueprintDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly stages: BlueprintStage[];
  readonly participantTemplates: BlueprintParticipantTemplate[];
  readonly requirements: BlueprintRequirementDefinition[];
}

export type ValidatedBlueprintStructure = Omit<BlueprintDefinition, 'id'>;

export interface NormalizedBlueprint {
  name: string;
  description: string | null;
  stages: { name: string; position: number }[];
  participantTemplates: { roleKey: string; displayName: string; position: number }[];
  requirements: {
    key: string;
    type: string;
    label: string;
    instructions: string | null;
    scope: BlueprintRequirementScope;
    participantRoleKey: string | null;
    stagePosition: number | null;
  }[];
}

/** Thrown by validateBlueprintStructure. No UseCaseError awareness — this is a pure domain module,
 *  shared by the read path and the write path, and must not depend on the application layer. */
export class BlueprintIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BlueprintIntegrityError';
  }
}

interface RawBlueprintDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  requirement_definitions: unknown;
  blueprint_stages: { id: string; name: string; position: number }[] | null;
  blueprint_participant_templates:
    | { id: string; role_key: string; display_name: string; position: number }[]
    | null;
}

/** Read-side normalizer: missing `scope` defaults to 'case' (legacy compatibility — no real
 *  Blueprint data predates the scope field except test fixtures). */
export function normalizeBlueprintFromDb(row: RawBlueprintDefinitionRow): NormalizedBlueprint {
  const rawStages = row.blueprint_stages ?? [];
  const rawTemplates = row.blueprint_participant_templates ?? [];
  const definitionsRaw = Array.isArray(row.requirement_definitions) ? row.requirement_definitions : [];

  return {
    name: row.name,
    description: row.description,
    stages: rawStages.map((s) => ({ name: s.name, position: s.position })),
    participantTemplates: rawTemplates.map((t) => ({
      roleKey: t.role_key,
      displayName: t.display_name,
      position: t.position,
    })),
    requirements: definitionsRaw.map((raw) => {
      const def = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
      return {
        key: typeof def.key === 'string' ? def.key : '',
        type: typeof def.type === 'string' ? def.type : 'document',
        label: typeof def.label === 'string' ? def.label : '',
        instructions: typeof def.instructions === 'string' ? def.instructions : null,
        // Only a missing scope defaults to 'case' (legacy compatibility); any other invalid value
        // (e.g. a typo'd scope string) must pass through unchanged so validateBlueprintStructure's
        // invalid_scope check actually catches it — silently coercing bad values here would let
        // corrupt data slip past validation undetected.
        scope: (def.scope ?? 'case') as BlueprintRequirementScope,
        participantRoleKey: typeof def.participant_role_key === 'string' ? def.participant_role_key : null,
        stagePosition: typeof def.stage_position === 'number' ? def.stage_position : null,
      };
    }),
  };
}

export interface SaveBlueprintDraftInput {
  name: string;
  description?: string;
  stages: { name: string; position: number }[];
  participantTemplates: { roleKey: string; displayName: string; position: number }[];
  requirements: (
    | { scope: 'case'; key: string; type: string; label: string; instructions?: string; stagePosition?: number }
    | { scope: 'participant'; key: string; type: string; label: string; instructions?: string; stagePosition?: number; participantRoleKey: string }
  )[];
}

/** Write-side normalizer: `scope` is required by the input type itself (the discriminated union
 *  has no third, scope-less branch) — never defaulted. New authoring must never produce
 *  legacy-shaped data. */
export function normalizeBlueprintDraft(input: SaveBlueprintDraftInput): NormalizedBlueprint {
  return {
    name: input.name,
    description: input.description ?? null,
    stages: input.stages.map((s) => ({ name: s.name, position: s.position })),
    participantTemplates: input.participantTemplates.map((t) => ({
      roleKey: t.roleKey,
      displayName: t.displayName,
      position: t.position,
    })),
    requirements: input.requirements.map((r) => ({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions ?? null,
      scope: r.scope,
      participantRoleKey: r.scope === 'participant' ? r.participantRoleKey : null,
      stagePosition: r.stagePosition ?? null,
    })),
  };
}

/**
 * The shared, pure domain validator. Called by both the read path (via normalizeBlueprintFromDb)
 * and the write path (via normalizeBlueprintDraft) — this is the single source of truth for every
 * Blueprint structural invariant. Throws BlueprintIntegrityError on the first violation found.
 */
export function validateBlueprintStructure(input: NormalizedBlueprint): ValidatedBlueprintStructure {
  const roleKeys = new Set<string>();
  const templatePositions = new Set<number>();
  for (const t of input.participantTemplates) {
    if (!isSlug(t.roleKey)) {
      throw new BlueprintIntegrityError('invalid_role_key', `Invalid participant-template role_key "${t.roleKey}"`);
    }
    if (roleKeys.has(t.roleKey)) {
      throw new BlueprintIntegrityError('duplicate_role_key', `Duplicate participant-template role_key "${t.roleKey}"`);
    }
    roleKeys.add(t.roleKey);
    if (templatePositions.has(t.position)) {
      throw new BlueprintIntegrityError('duplicate_participant_position', `Duplicate participant-template position ${t.position}`);
    }
    templatePositions.add(t.position);
  }

  const stagePositions = new Set<number>();
  for (const s of input.stages) {
    if (stagePositions.has(s.position)) {
      throw new BlueprintIntegrityError('duplicate_stage_position', `Duplicate stage position ${s.position}`);
    }
    stagePositions.add(s.position);
  }

  const bucketKeys = new Map<string, Set<string>>();
  const requirements: BlueprintRequirementDefinition[] = [];

  for (const r of input.requirements) {
    if (!isSlug(r.key)) {
      throw new BlueprintIntegrityError('invalid_key', `Invalid or missing key "${r.key}"`);
    }
    if (!r.label || r.label.trim().length === 0) {
      throw new BlueprintIntegrityError('missing_label', `Missing or empty label for key "${r.key}"`);
    }
    if (r.scope !== 'case' && r.scope !== 'participant') {
      throw new BlueprintIntegrityError('invalid_scope', `Invalid scope "${String(r.scope)}" for key "${r.key}"`);
    }
    if (r.scope === 'participant') {
      if (!r.participantRoleKey || r.participantRoleKey.trim().length === 0) {
        throw new BlueprintIntegrityError('missing_participant_role_key', `Scope "participant" without participantRoleKey for key "${r.key}"`);
      }
      if (!roleKeys.has(r.participantRoleKey)) {
        throw new BlueprintIntegrityError('orphaned_role_key', `Orphaned participantRoleKey "${r.participantRoleKey}" for key "${r.key}"`);
      }
    } else if (r.participantRoleKey !== null) {
      throw new BlueprintIntegrityError('unexpected_participant_role_key', `Scope "case" must not carry participantRoleKey for key "${r.key}"`);
    }

    if (r.stagePosition !== null && !stagePositions.has(r.stagePosition)) {
      throw new BlueprintIntegrityError('orphaned_stage_position', `stagePosition ${r.stagePosition} does not exist for key "${r.key}"`);
    }

    const bucket = r.scope === 'case' ? 'case' : `participant:${r.participantRoleKey}`;
    const seenInBucket = bucketKeys.get(bucket) ?? new Set<string>();
    if (seenInBucket.has(r.key)) {
      throw new BlueprintIntegrityError('duplicate_key', `Duplicate key "${r.key}" in bucket "${bucket}"`);
    }
    seenInBucket.add(r.key);
    bucketKeys.set(bucket, seenInBucket);

    requirements.push({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions,
      scope: r.scope,
      participantRoleKey: r.participantRoleKey,
      stagePosition: r.stagePosition,
    });
  }

  return {
    name: input.name,
    description: input.description,
    stages: [...input.stages].sort((a, b) => a.position - b.position),
    participantTemplates: [...input.participantTemplates]
      .sort((a, b) => a.position - b.position)
      .map((t) => ({ id: '', roleKey: t.roleKey, displayName: t.displayName, position: t.position })),
    requirements,
  } as ValidatedBlueprintStructure;
}

/**
 * The strict, validated Blueprint a Case is actually cloned from.
 *
 * Unlike listBlueprintSummaries, this throws BlueprintIntegrityError (an internal-consistency bug,
 * not a UseCaseError) on the first integrity violation found — via validateBlueprintStructure,
 * shared with the write path (saveBlueprint).
 */
export async function getBlueprintDefinition(
  client: DbClient,
  blueprintId: string,
  organizationId: string,
): Promise<BlueprintDefinition | null> {
  const { data, error } = await client
    .from('blueprints')
    .select(
      'id, name, description, requirement_definitions, blueprint_stages(id, name, position), blueprint_participant_templates(id, role_key, display_name, position)',
    )
    .eq('id', blueprintId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw new Error(`getBlueprintDefinition: ${error.message}`);
  if (!data) return null;

  const row = data as RawBlueprintDefinitionRow;
  // Stage/template ids are needed on the returned shape (BlueprintStage/BlueprintParticipantTemplate
  // both carry `id`), but NormalizedBlueprint intentionally drops them — they're not a structural
  // invariant, just DB identity. Re-attach them here by matching on (name, position) / (roleKey,
  // position), which validateBlueprintStructure's own sort makes safe (positions are already
  // proven unique by the validator itself).
  const validated = validateBlueprintStructure(normalizeBlueprintFromDb(row));
  const rawStagesById = new Map((row.blueprint_stages ?? []).map((s) => [s.position, s.id]));
  const rawTemplatesById = new Map((row.blueprint_participant_templates ?? []).map((t) => [t.position, t.id]));

  return {
    id: row.id,
    name: validated.name,
    description: validated.description,
    stages: validated.stages.map((s) => ({ id: rawStagesById.get(s.position) ?? '', name: s.name, position: s.position })),
    participantTemplates: validated.participantTemplates.map((t) => ({
      id: rawTemplatesById.get(t.position) ?? '',
      roleKey: t.roleKey,
      displayName: t.displayName,
      position: t.position,
    })),
    requirements: validated.requirements,
  };
}

/** Usage count for the edit screen's persistent banner. Kept separate from BlueprintDefinition —
 *  a transport-layer concern of the edit route, not part of the pure structural read. An error
 *  propagates rather than silently reporting 0: an unknown failure must never look like "unused". */
export async function countCasesUsingBlueprint(
  client: DbClient,
  blueprintId: string,
  organizationId: string,
): Promise<number> {
  const { count, error } = await client
    .from('cases')
    .select('*', { count: 'exact', head: true })
    .eq('origin_blueprint_id', blueprintId)
    .eq('organization_id', organizationId);

  if (error) throw new Error(`countCasesUsingBlueprint: ${error.message}`);
  return count ?? 0;
}
