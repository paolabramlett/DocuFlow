"use server";

/*
 * Server Action for Configuración. Thin: re-establish identity, delegate to the use case, return
 * a typed result. The owner check here is a fast, user-facing rejection for a non-owner hitting
 * this by direct POST — updateOrganization re-checks independently, and RLS is the final floor.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import { updateOrganization, type UpdateOrganizationInput } from "@/application/update-organization";

export async function updateOrganizationAction(
  input: Omit<UpdateOrganizationInput, "organizationId">,
): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    if (staff.role !== "owner") {
      return { ok: false, reason: "forbidden", message: "Solo el propietario puede editar esta información." };
    }

    const supabase = await createClient();
    await updateOrganization(supabase, { ...input, organizationId: staff.organizationId });

    revalidatePath("/settings");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
