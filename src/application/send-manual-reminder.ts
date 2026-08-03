import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";
import { reissueParticipantInvitation } from "@/features/case-access/invitations";
import { sendTransactionalEmail, type SendTransactionalEmailInput } from "@/lib/email/resend";
import { escapeHtml } from "@/lib/email/escape-html";
import { APP_ORIGIN } from "@/lib/supabase/env";

type DbClient = SupabaseClient<Database>;

const sendManualReminderSchema = z.object({
  organizationId: z.string().uuid(),
  caseId: z.string().uuid(),
});

export type SendManualReminderInput = z.input<typeof sendManualReminderSchema>;

export interface SendManualReminderResult {
  readonly remindedCount: number;
  readonly failures: { readonly email: string; readonly reason: string }[];
}

/**
 * The "Recordar" button's use case: force a reminder to every participant of this Case who still
 * has outstanding work, right now, ignoring the automatic cadence entirely (staff explicitly asked
 * for this behavior — an on-demand nudge that doesn't wait for or count against the cadence-driven
 * reminders in app.select_due_reminders()).
 *
 * "Outstanding" matches the automatic reminder system's own definition exactly (status <>
 * 'satisfied', not deleted/superseded) — the manual and automatic paths must agree on who needs a
 * nudge, even though only this one bypasses the cadence timing.
 *
 * Each reminder rotates that participant's Portal credential via reissueParticipantInvitation
 * (features/case-access/invitations.ts) — the same reissue path the reminder cron uses via the
 * emit_participant_invitation RPC — rather than trying to resend an unrecoverable original token.
 */
export async function sendManualReminder(
  client: DbClient,
  input: SendManualReminderInput,
  actorAuthUserId: string,
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
): Promise<SendManualReminderResult> {
  const { organizationId, caseId } = sendManualReminderSchema.parse(input);

  const { data: caseRow, error: caseError } = await client
    .from("cases")
    .select("title, organization:organizations(name)")
    .eq("id", caseId)
    .eq("organization_id", organizationId)
    .single();
  if (caseError || !caseRow) {
    throw new UseCaseError("not_found", "El expediente ya no existe.");
  }
  const organizationName = caseRow.organization?.name ?? "Avanza";

  const { data: participants, error: participantsError } = await client
    .from("case_participants")
    .select(
      "id, requirements(id, status, deleted_at, superseded_at), grants:case_access_grants(id, revoked_at, permission, invited_email)",
    )
    .eq("case_id", caseId)
    .eq("organization_id", organizationId);
  if (participantsError) {
    throw new Error(`Could not read participants: ${participantsError.message}`);
  }

  let remindedCount = 0;
  const failures: SendManualReminderResult["failures"] = [];

  for (const p of participants ?? []) {
    const hasOutstanding = (p.requirements ?? []).some(
      (r) => r.status !== "satisfied" && !r.deleted_at && !r.superseded_at,
    );
    if (!hasOutstanding) continue;

    // A revoked or explicitly no-access grant is not "forgot to check their email" — nothing to
    // remind them about. A participant with no grant at all was never even invited; that's a
    // different, prior failure this action does not try to paper over.
    const activeGrant = (p.grants ?? []).find((g) => g.revoked_at === null && g.permission !== "none");
    if (!activeGrant) continue;

    try {
      const reissued = await reissueParticipantInvitation(client, p.id);
      await sendEmail({
        to: reissued.invitedEmail,
        subject: `Recordatorio: te esperan en ${organizationName}`,
        html: `<h2>Aún necesitamos algunos documentos tuyos</h2>\n<p>${escapeHtml(organizationName)} está esperando información para continuar con tu expediente. Usa el siguiente enlace:</p>\n<p><a href="${APP_ORIGIN}/portal/${reissued.token}">Ir a mi expediente</a></p>`,
        idempotencyKey: `case-reminder-manual/${caseId}/${p.id}/${Date.now()}`,
      });
      remindedCount += 1;
    } catch (cause) {
      failures.push({
        email: activeGrant.invited_email,
        reason: cause instanceof Error ? cause.message : "No se pudo enviar el recordatorio",
      });
    }
  }

  await logDomainEvent(client, {
    organizationId,
    caseId,
    action: "reminder.sent_manual",
    targetType: "case",
    targetId: caseId,
    actor: { kind: "member", authUserId: actorAuthUserId },
    metadata: { remindedCount, failureCount: failures.length },
  });

  return { remindedCount, failures };
}
