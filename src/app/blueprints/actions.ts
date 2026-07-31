"use server";

/*
 * Server Actions for Blueprint authoring. Kept separate from src/app/cases/actions.ts so the
 * Plantillas module never depends on the Expedientes module.
 *
 * Thin: authenticate, owner-gate, delegate to the application use case, return a typed result —
 * matching src/app/cases/actions.ts's and src/app/settings/actions.ts's existing conventions.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import { saveBlueprint, type SaveBlueprintInput } from "@/application/save-blueprint";
import { deleteBlueprint } from "@/application/delete-blueprint";
import { getBlueprintDefinition, type BlueprintDefinition } from "@/features/blueprints/queries";

export async function saveBlueprintAction(
  input: Omit<SaveBlueprintInput, "organizationId">,
): Promise<ActionResult<{ blueprintId: string }>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    if (staff.role !== "owner") {
      return { ok: false, reason: "forbidden", message: "Solo el propietario puede crear o editar plantillas." };
    }

    const client = await createClient();
    const result = await saveBlueprint(client, { ...input, organizationId: staff.organizationId }, staff.userId);
    revalidatePath("/blueprints");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function deleteBlueprintAction(blueprintId: string): Promise<ActionResult<{ blueprintId: string }>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    if (staff.role !== "owner") {
      return { ok: false, reason: "forbidden", message: "Solo el propietario puede eliminar plantillas." };
    }

    const client = await createClient();
    const result = await deleteBlueprint(client, { organizationId: staff.organizationId, blueprintId }, staff.userId);
    revalidatePath("/blueprints");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function getBlueprintDefinitionAction(
  blueprintId: string,
): Promise<ActionResult<BlueprintDefinition>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const client = await createClient();
    const definition = await getBlueprintDefinition(client, blueprintId, staff.organizationId);
    if (!definition) {
      return { ok: false, reason: "not_found", message: "La plantilla ya no existe." };
    }
    return ok(definition);
  } catch (error) {
    return fail(error);
  }
}
