import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { UseCaseError } from "./errors";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { decideReview } from "@/features/documents/documents";
import { reissueParticipantInvitation } from "@/features/case-access/invitations";
import { sendTransactionalEmail, type SendTransactionalEmailInput } from "@/lib/email/resend";
import { escapeHtml } from "@/lib/email/escape-html";
import { APP_ORIGIN } from "@/lib/supabase/env";

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
 * Coalesces a burst of decisions requiring client action into one email rather than one per
 * decision — a reviewer rejecting five documents in a row should produce one "you have 5 items to
 * fix" email, not five near-identical ones. Deliberately short: long enough to absorb a single
 * review pass, short enough that a genuinely new rejection an hour later still notifies promptly.
 */
const ACTION_REQUIRED_NOTIFICATION_COOLDOWN_MINUTES = 5;

/**
 * The general rule, not the one case that satisfies it today: does this decision leave the client
 * with something to do? Only 'rejected' qualifies right now — approval requires no action and
 * would just be volume-of-approvals noise — but a future decision kind (e.g. "needs more info")
 * only has to extend this predicate, not add a second notification path.
 */
function requiresClientAction(decision: "approved" | "rejected"): boolean {
  return decision === "rejected";
}

/**
 * Approve or reject an uploaded Document.
 *
 * Thin orchestration over the domain module: it validates the business rule that a rejection must
 * carry a reason (the client sees it and needs to know what to fix), then delegates. The database
 * trigger moves the Requirement's status, so approval satisfies it and rejection reopens it
 * regardless of which caller wrote the review; prior reviews are never modified.
 *
 * A rejection also emails the participant, best-effort: the review itself has already succeeded by
 * the time notification is attempted, so a notification failure is logged and swallowed rather than
 * surfaced as a failed review — the reviewer's decision is real regardless of whether the client
 * learns about it by email or by checking the Portal themselves.
 */
export async function reviewDocument(
  client: DbClient,
  input: ReviewDocumentInput,
  actorAuthUserId: string,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
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

  if (!requiresClientAction(parsed.decision)) return;

  try {
    await notifyParticipantActionRequired(client, parsed.documentId, parsed.reason ?? "", sendEmail);
  } catch (cause) {
    console.error("Failed to notify participant of a decision requiring their action", {
      documentId: parsed.documentId,
      cause,
    });
  }
}

async function notifyParticipantActionRequired(
  client: DbClient,
  documentId: string,
  reason: string,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void>,
): Promise<void> {
  const { data: document, error: documentError } = await client
    .from("documents")
    .select("case_id, requirement:requirements(label, participant_id)")
    .eq("id", documentId)
    .maybeSingle();
  if (documentError || !document?.requirement) return;

  const participantId = document.requirement.participant_id;
  if (!participantId) return;

  const { data: caseRow } = await client
    .from("cases")
    .select("title, organization:organizations(name)")
    .eq("id", document.case_id)
    .maybeSingle();
  const organizationName = caseRow?.organization?.name ?? "Avanza";
  const caseTitle = caseRow?.title ?? "";

  const { data: grant, error: grantError } = await client
    .from("case_access_grants")
    .select("id, invited_email, revoked_at, permission, action_required_notified_at")
    .eq("participant_id", participantId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (grantError || !grant || grant.revoked_at !== null || grant.permission === "none") return;

  if (grant.action_required_notified_at) {
    const elapsedMinutes = (Date.now() - Date.parse(grant.action_required_notified_at)) / 60_000;
    if (elapsedMinutes < ACTION_REQUIRED_NOTIFICATION_COOLDOWN_MINUTES) return;
  }

  const { count: actionableCount } = await client
    .from("requirements")
    .select("id", { count: "exact", head: true })
    .eq("participant_id", participantId)
    .is("deleted_at", null)
    .is("superseded_at", null)
    .neq("status", "satisfied");

  const reissued = await reissueParticipantInvitation(client, participantId);
  const count = actionableCount ?? 1;
  const safeCaseTitle = escapeHtml(caseTitle);
  const summary =
    count > 1
      ? `Tienes ${count} documentos que requieren tu atención en ${safeCaseTitle}.`
      : `Tu documento <strong>${escapeHtml(document.requirement.label)}</strong> necesita corrección en ${safeCaseTitle}.`;

  await sendEmail({
    to: grant.invited_email,
    subject: `Acción requerida — ${organizationName}`,
    html: `<h2>Necesitamos que revises algo</h2>\n<p>${summary}</p>\n<p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>\n<p><a href="${APP_ORIGIN}/portal/${reissued.token}">Ir a mi expediente</a></p>`,
    idempotencyKey: `review-action-required/${grant.id}/${Date.now()}`,
  });

  await client
    .from("case_access_grants")
    .update({ action_required_notified_at: new Date().toISOString() })
    .eq("id", grant.id);
}
