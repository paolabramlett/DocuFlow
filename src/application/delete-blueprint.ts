import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";

type DbClient = SupabaseClient<Database>;

export interface DeleteBlueprintInput {
  organizationId: string;
  blueprintId: string;
}

export async function deleteBlueprint(
  client: DbClient,
  input: DeleteBlueprintInput,
  actorAuthUserId: string,
): Promise<{ blueprintId: string }> {
  const { data, error } = await client
    .from("blueprints")
    .delete()
    .eq("id", input.blueprintId)
    .eq("organization_id", input.organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") {
      throw new UseCaseError("forbidden", "No tienes permiso para eliminar esta plantilla.");
    }
    throw error;
  }
  if (!data) {
    throw new UseCaseError("not_found", "La plantilla no existe o ya fue eliminada.");
  }

  await logDomainEvent(client, {
    organizationId: input.organizationId,
    action: "blueprint.deleted",
    targetType: "blueprint",
    targetId: data.id,
    actor: { kind: "member", authUserId: actorAuthUserId },
  });

  return { blueprintId: data.id };
}
