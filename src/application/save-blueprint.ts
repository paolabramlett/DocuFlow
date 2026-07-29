import type { ValidatedBlueprintStructure } from "@/features/blueprints/queries";

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
