"use server";

/*
 * Server Actions for Cases.
 *
 * Deliberately thin: authenticate, delegate to an application use case, revalidate, return a
 * typed result. No business logic lives here — that is in src/application/*, so a script, a
 * future API, or a different UI gets identical behaviour.
 *
 * Server Actions are reachable by direct POST, not only through our UI, so every one of them
 * re-establishes the caller's identity rather than trusting anything from the client.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import {
  createCaseWithParticipants,
  type CreateCaseWithParticipantsInput,
  type CreatedCase,
} from "@/application/create-case-with-participants";
import { reviewDocument, type ReviewDocumentInput } from "@/application/review-document";
import { createDocumentDownloadUrl } from "@/features/documents/documents";
import { sendManualReminder, type SendManualReminderResult } from "@/application/send-manual-reminder";
import { getBlueprintDefinition, type BlueprintDefinition } from "@/features/blueprints/queries";
import { closeCase, reopenCase } from "@/features/cases/cases";

export async function createCaseAction(
  input: Omit<CreateCaseWithParticipantsInput, "organizationId">,
): Promise<ActionResult<CreatedCase>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    const result = await createCaseWithParticipants(
      supabase,
      { ...input, organizationId: staff.organizationId },
      staff.userId,
    );

    revalidatePath("/cases");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function reviewDocumentAction(input: ReviewDocumentInput): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    await reviewDocument(supabase, input, staff.userId);

    revalidatePath("/cases");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function sendManualReminderAction(caseId: string): Promise<ActionResult<SendManualReminderResult>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    const result = await sendManualReminder(supabase, { organizationId: staff.organizationId, caseId }, staff.userId);

    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function getDocumentDownloadUrlAction(documentId: string): Promise<ActionResult<string>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    const url = await createDocumentDownloadUrl(supabase, documentId);

    return ok(url);
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

    const supabase = await createClient();
    const definition = await getBlueprintDefinition(supabase, blueprintId, staff.organizationId);

    if (!definition) {
      return { ok: false, reason: "not_found", message: "La plantilla ya no existe." };
    }

    return ok(definition);
  } catch (error) {
    return fail(error);
  }
}

export async function closeCaseAction(
  caseId: string,
  outcome: "completed" | "cancelled",
  closingNote?: string,
): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    await closeCase(supabase, caseId, outcome, closingNote);

    revalidatePath("/cases");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}

export async function reopenCaseAction(
  caseId: string,
): Promise<ActionResult<{ requiresReinvitation: boolean; notificationFailureCount: number }>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const supabase = await createClient();
    const { requiresReinvitation, notificationFailureCount } = await reopenCase(supabase, caseId);

    revalidatePath("/cases");
    return ok({ requiresReinvitation, notificationFailureCount });
  } catch (error) {
    return fail(error);
  }
}
