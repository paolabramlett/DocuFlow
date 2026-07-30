import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";
import {
  BLUEPRINT_INTEGRITY_MESSAGES,
  BlueprintIntegrityError,
  normalizeBlueprintDraft,
  validateBlueprintStructure,
  type ValidatedBlueprintStructure,
} from "@/features/blueprints/queries";

type DbClient = SupabaseClient<Database>;

/**
 * The one place that converts a validated Blueprint (camelCase, canonical) into the snake_case
 * shape the save_blueprint RPC and the stored requirement_definitions JSON both expect. Applied
 * immediately before the .rpc() call — the SQL layer never has camelCase awareness.
 */
export function toPersistenceJson(validated: ValidatedBlueprintStructure): {
  stages: { name: string; position: number }[];
  participantTemplates: { role_key: string; display_name: string; position: number }[];
  requirements: {
    key: string;
    type: string;
    label: string;
    instructions: string | null;
    scope: "case" | "participant";
    participant_role_key: string | null;
    stage_position: number | null;
  }[];
} {
  return {
    stages: validated.stages.map((s) => ({ name: s.name, position: s.position })),
    participantTemplates: validated.participantTemplates.map((t) => ({
      role_key: t.roleKey,
      display_name: t.displayName,
      position: t.position,
    })),
    requirements: validated.requirements.map((r) => ({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions,
      scope: r.scope,
      participant_role_key: r.participantRoleKey,
      stage_position: r.stagePosition,
    })),
  };
}

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const roleKeySchema = z.string().trim().min(1).max(100).regex(slugPattern, "Debe ser un identificador en formato slug");
const requirementKeySchema = z.string().trim().min(1).max(200).regex(slugPattern, "Debe ser un identificador en formato slug");
const requirementTypeSchema = z.string().trim().min(1).max(100);

const stageSchema = z.object({
  name: z.string().trim().min(1).max(200),
  position: z.number().int().min(0),
}).strict();

const participantTemplateSchema = z.object({
  roleKey: roleKeySchema,
  displayName: z.string().trim().min(1).max(200),
  position: z.number().int().min(0),
}).strict();

const requirementSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("case"),
    key: requirementKeySchema,
    type: requirementTypeSchema,
    label: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(2000).optional(),
    stagePosition: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    scope: z.literal("participant"),
    key: requirementKeySchema,
    type: requirementTypeSchema,
    label: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(2000).optional(),
    stagePosition: z.number().int().min(0).optional(),
    participantRoleKey: roleKeySchema,
  }).strict(),
]);

export const saveBlueprintSchema = z.object({
  organizationId: z.string().uuid(),
  blueprintId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  stages: z.array(stageSchema),
  participantTemplates: z.array(participantTemplateSchema),
  requirements: z.array(requirementSchema),
}).strict();

export type SaveBlueprintInput = z.input<typeof saveBlueprintSchema>;

const RPC_VALIDATION_MESSAGES: Record<string, string> = {
  invalid_stages_payload: "El formato de las etapas no es válido.",
  invalid_participant_templates_payload: "El formato de los roles de participante no es válido.",
  invalid_requirements_payload: "El formato de los requisitos no es válido.",
  invalid_blueprint_name: "El nombre de la plantilla no es válido.",
  invalid_blueprint_description: "La descripción es demasiado larga.",
  invalid_stage_shape: "Una etapa tiene datos inválidos.",
  duplicate_stage_position: "No puede haber dos etapas con la misma posición.",
  invalid_participant_template_shape: "Un rol de participante tiene datos inválidos.",
  duplicate_participant_role_key: "Cada rol de participante debe tener un identificador único.",
  duplicate_participant_position: "No puede haber dos roles de participante con la misma posición.",
  invalid_requirement_shape: "Un requisito tiene datos inválidos.",
  unknown_participant_role_key: "Un requisito hace referencia a un rol de participante inexistente.",
  unknown_stage_position: "Un requisito hace referencia a una etapa inexistente.",
  duplicate_requirement_key: "Cada requisito debe tener una clave única dentro de su alcance.",
};

export async function saveBlueprint(
  client: DbClient,
  input: SaveBlueprintInput,
  actorAuthUserId: string,
): Promise<{ blueprintId: string }> {
  let parsed;
  try {
    parsed = parseInput(saveBlueprintSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError("validation", "Revisa los datos de la plantilla.", error.issues);
    }
    throw error;
  }

  let validated;
  try {
    validated = validateBlueprintStructure(normalizeBlueprintDraft(parsed));
  } catch (error) {
    if (error instanceof BlueprintIntegrityError) {
      throw new UseCaseError("validation", BLUEPRINT_INTEGRITY_MESSAGES[error.code] ?? "Los datos de la plantilla no son válidos.");
    }
    throw error;
  }

  const persistence = toPersistenceJson(validated);

  // target_blueprint_id / blueprint_description are optional (no-null-union) keys in the
  // generated RPC Args type, per the migration's `default null` on both — the key is omitted
  // entirely rather than set to an explicit `null`, matching create_case's own from_blueprint_id
  // convention (discovered as a real typecheck mismatch during Task 3; fixed retroactively in
  // Task 1's migration rather than left as a plan inconsistency).
  const { data: blueprintId, error } = await client.rpc("save_blueprint", {
    target_organization_id: parsed.organizationId,
    ...(parsed.blueprintId !== undefined ? { target_blueprint_id: parsed.blueprintId } : {}),
    blueprint_name: validated.name,
    ...(validated.description !== null ? { blueprint_description: validated.description } : {}),
    stages: persistence.stages,
    participant_templates: persistence.participantTemplates,
    requirement_definitions: persistence.requirements,
  });

  if (error) {
    const code = error.message;
    if (code in RPC_VALIDATION_MESSAGES) {
      throw new UseCaseError("validation", RPC_VALIDATION_MESSAGES[code]!);
    }
    if (code === "blueprint_not_found") {
      throw new UseCaseError("not_found", "La plantilla ya no existe.");
    }
    if (code === "not_owner") {
      throw new UseCaseError("forbidden", "Solo el propietario puede editar esta plantilla.");
    }
    throw error;
  }

  await logDomainEvent(client, {
    organizationId: parsed.organizationId,
    action: parsed.blueprintId ? "blueprint.updated" : "blueprint.created",
    targetType: "blueprint",
    targetId: blueprintId!,
    actor: { kind: "member", authUserId: actorAuthUserId },
  });

  return { blueprintId: blueprintId! };
}
