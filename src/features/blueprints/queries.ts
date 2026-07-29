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

/**
 * The strict, validated Blueprint a Case is actually cloned from.
 *
 * Unlike listBlueprintSummaries, this throws a plain Error (an internal-consistency bug, not a
 * UseCaseError) on the first integrity violation found. The wizard always reads a Blueprint
 * through here before ever creating a Case from it, so this is the real gate — create_case's own
 * `coalesce(scope, 'case')` filter is a last-resort backstop only for direct-DB-manipulation edge
 * cases this function's own validation would already have caught for any app-driven path.
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
  const rawStages = row.blueprint_stages ?? [];
  const rawTemplates = row.blueprint_participant_templates ?? [];

  const roleKeys = new Set<string>();
  const templatePositions = new Set<number>();
  for (const t of rawTemplates) {
    if (!isSlug(t.role_key)) {
      throw new Error(
        `Blueprint integrity error: invalid participant-template role_key "${t.role_key}" (blueprint ${blueprintId})`,
      );
    }
    if (roleKeys.has(t.role_key)) {
      throw new Error(
        `Blueprint integrity error: duplicate participant-template role_key "${t.role_key}" (blueprint ${blueprintId})`,
      );
    }
    roleKeys.add(t.role_key);
    if (templatePositions.has(t.position)) {
      throw new Error(
        `Blueprint integrity error: duplicate participant-template position ${t.position} (blueprint ${blueprintId})`,
      );
    }
    templatePositions.add(t.position);
  }

  const stagePositions = new Set<number>();
  for (const s of rawStages) {
    if (stagePositions.has(s.position)) {
      throw new Error(`Blueprint integrity error: duplicate stage position ${s.position} (blueprint ${blueprintId})`);
    }
    stagePositions.add(s.position);
  }

  const definitionsRaw = Array.isArray(row.requirement_definitions) ? row.requirement_definitions : [];
  const bucketKeys = new Map<string, Set<string>>();
  const requirements: BlueprintRequirementDefinition[] = [];

  for (const raw of definitionsRaw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(
        `Blueprint integrity error: requirement definition is not a plain object (blueprint ${blueprintId})`,
      );
    }
    const def = raw as Record<string, unknown>;

    if (!isSlug(def.key)) {
      throw new Error(
        `Blueprint integrity error: invalid or missing key "${String(def.key)}" (blueprint ${blueprintId})`,
      );
    }
    const key = def.key as string;

    if (typeof def.label !== 'string' || def.label.trim().length === 0) {
      throw new Error(`Blueprint integrity error: missing or empty label for key "${key}" (blueprint ${blueprintId})`);
    }

    const scopeRaw = def.scope ?? 'case';
    if (scopeRaw !== 'case' && scopeRaw !== 'participant') {
      throw new Error(
        `Blueprint integrity error: invalid scope "${String(scopeRaw)}" for key "${key}" (blueprint ${blueprintId})`,
      );
    }
    const scope = scopeRaw as BlueprintRequirementScope;

    const participantRoleKeyRaw = def.participant_role_key;
    let participantRoleKey: string | null = null;
    if (scope === 'participant') {
      if (typeof participantRoleKeyRaw !== 'string' || participantRoleKeyRaw.trim().length === 0) {
        throw new Error(
          `Blueprint integrity error: scope "participant" without participant_role_key for key "${key}" (blueprint ${blueprintId})`,
        );
      }
      if (!roleKeys.has(participantRoleKeyRaw)) {
        throw new Error(
          `Blueprint integrity error: orphaned participant_role_key "${participantRoleKeyRaw}" for key "${key}" (blueprint ${blueprintId})`,
        );
      }
      participantRoleKey = participantRoleKeyRaw;
    } else if (participantRoleKeyRaw !== undefined && participantRoleKeyRaw !== null) {
      throw new Error(
        `Blueprint integrity error: scope "case" must not carry participant_role_key for key "${key}" (blueprint ${blueprintId})`,
      );
    }

    const stagePositionRaw = def.stage_position;
    let stagePosition: number | null = null;
    if (stagePositionRaw !== undefined && stagePositionRaw !== null) {
      if (typeof stagePositionRaw !== 'number' || !stagePositions.has(stagePositionRaw)) {
        throw new Error(
          `Blueprint integrity error: stage_position ${String(stagePositionRaw)} does not exist for key "${key}" (blueprint ${blueprintId})`,
        );
      }
      stagePosition = stagePositionRaw;
    }

    const bucket = scope === 'case' ? 'case' : `participant:${participantRoleKey}`;
    const seenInBucket = bucketKeys.get(bucket) ?? new Set<string>();
    if (seenInBucket.has(key)) {
      throw new Error(`Blueprint integrity error: duplicate key "${key}" in bucket "${bucket}" (blueprint ${blueprintId})`);
    }
    seenInBucket.add(key);
    bucketKeys.set(bucket, seenInBucket);

    requirements.push({
      key,
      type: typeof def.type === 'string' ? def.type : 'document',
      label: def.label,
      instructions: typeof def.instructions === 'string' ? def.instructions : null,
      scope,
      participantRoleKey,
      stagePosition,
    });
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stages: [...rawStages].sort((a, b) => a.position - b.position).map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
    })),
    participantTemplates: [...rawTemplates].sort((a, b) => a.position - b.position).map((t) => ({
      id: t.id,
      roleKey: t.role_key,
      displayName: t.display_name,
      position: t.position,
    })),
    requirements, // preserves original JSON array order — that order is their canonical position
  };
}
