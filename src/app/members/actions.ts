"use server";

/*
 * Server Action for Miembros. Thin: re-establish identity, fast-reject a non-owner before ever
 * calling the use case, delegate, return a typed result. inviteMember re-verifies independently
 * regardless — this check is a fast, user-facing rejection for a non-owner hitting this by
 * direct POST, not the real authorization boundary.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fail, ok, type ActionResult } from "@/application/errors";
import { inviteMember } from "@/application/invite-member";

export async function inviteMemberAction(email: string): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    if (staff.role !== "owner") {
      return { ok: false, reason: "forbidden", message: "Solo el propietario puede invitar miembros." };
    }

    const supabase = await createClient();
    await inviteMember(supabase, createAdminClient(), { organizationId: staff.organizationId, email });

    revalidatePath("/members");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
