import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { UseCaseError } from "./errors";
import { decideReview } from "@/features/documents/documents";

type DbClient = SupabaseClient<Database>;

export const reviewDocumentSchema = z
  .object({
    documentId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.decision !== "rejected" || (v.reason && v.reason.length > 0), {
    path: ["reason"],
    message: "Explica por qué se rechaza — el cliente verá este motivo.",
  });

export type ReviewDocumentInput = z.input<typeof reviewDocumentSchema>;

/**
 * Approve or reject an uploaded Document.
 *
 * Thin orchestration over the domain module: it validates the business rule that a rejection must
 * carry a reason (the client sees it and needs to know what to fix), then delegates. The database
 * trigger moves the Requirement's status, so approval satisfies it and rejection reopens it
 * regardless of which caller wrote the review; prior reviews are never modified.
 */
export async function reviewDocument(
  client: DbClient,
  input: ReviewDocumentInput,
  actorAuthUserId: string,
): Promise<void> {
  let parsed;
  try {
    parsed = parseInput(reviewDocumentSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError("validation", "Revisa la decisión.", error.issues);
    }
    throw error;
  }

  try {
    await decideReview(client, parsed, actorAuthUserId);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("No such document")) {
      throw new UseCaseError("not_found", "Ese documento ya no está disponible.");
    }
    throw new UseCaseError(
      "forbidden",
      "No pudimos registrar la revisión. Verifica que tengas acceso a este expediente.",
    );
  }
}
