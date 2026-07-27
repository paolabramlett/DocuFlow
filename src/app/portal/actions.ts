"use server";

/*
 * Server Actions for the Client Portal.
 *
 * Thin by the same rule as the Staff side (src/app/cases/actions.ts): authenticate or accept the
 * token, delegate to src/application/client-portal.ts, return a typed result. No business logic
 * here — retries, lifecycle transitions, and authorization all live in the use cases.
 */

import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import {
  getPortalState,
  requestAccessCode,
  uploadRequirementDocument,
  verifyAccessCode,
  type PortalState,
} from "@/application/client-portal";

export async function requestAccessCodeAction(token: string): Promise<ActionResult<null>> {
  try {
    const supabase = await createClient();
    await requestAccessCode(supabase, { token });
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function verifyAccessCodeAction(token: string, code: string): Promise<ActionResult<PortalState>> {
  try {
    const supabase = await createClient();
    // Sets the session cookie on success (the server client's cookie adapter can write here,
    // unlike inside a Server Component render).
    await verifyAccessCode(supabase, { token, code });
    const state = await getPortalState(supabase, token);
    return ok(state);
  } catch (error) {
    return fail(error);
  }
}

export async function getPortalStateAction(token: string): Promise<ActionResult<PortalState>> {
  try {
    const supabase = await createClient();
    return ok(await getPortalState(supabase, token));
  } catch (error) {
    return fail(error);
  }
}

export async function uploadRequirementDocumentAction(
  token: string,
  requirementId: string,
  formData: FormData,
): Promise<ActionResult<null>> {
  try {
    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Ingresa tu código de nuevo." };
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return { ok: false, reason: "validation", message: "Selecciona un archivo para subir." };
    }

    await uploadRequirementDocument(
      supabase,
      {
        token,
        requirementId,
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        file,
      },
      user.id,
    );

    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
