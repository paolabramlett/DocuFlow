import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";
import { addRequirement, createCase } from "@/features/cases/cases";
import { createParticipant, findOrCreateClient } from "@/features/participants/participants";
import { issueInvitation } from "@/features/case-access/invitations";

type DbClient = SupabaseClient<Database>;

export const createCaseWithParticipantsSchema = z.object({
  organizationId: z.string().uuid(),
  title: z.string().trim().min(1, "Ponle un título al expediente").max(300),
  blueprintId: z.string().uuid().optional(),
  participants: z
    .array(
      z.object({
        roleLabel: z.string().trim().min(1, "Cada participante necesita un rol").max(100),
        fullName: z.string().trim().min(1, "Cada participante necesita un nombre").max(200),
        email: z.string().trim().toLowerCase().email("Revisa el correo electrónico").max(320),
        requirements: z.array(z.string().trim().min(1).max(300)),
      }),
    )
    .min(1, "Agrega al menos un participante"),
  /** Whether to issue invitations now. The wizard always does; other callers may not. */
  sendInvitations: z.boolean().default(true),
});

export type CreateCaseWithParticipantsInput = z.input<typeof createCaseWithParticipantsSchema>;

export interface CreatedCase {
  readonly caseId: string;
  readonly participants: { id: string; name: string; email: string; role: string; invited: boolean }[];
  /** Participants whose invitation could not be issued. The Case still exists. */
  readonly invitationFailures: { email: string; reason: string }[];
}

/**
 * The Create Case workflow, end to end.
 *
 * Orchestrates the whole business operation in one place so Server Actions stay thin and any
 * other caller (a script, a future API, a different UI) gets identical behaviour:
 *
 *   1. Create the Case — cloning the Blueprint when one was chosen (deep copy; the Case is
 *      independent from that moment on).
 *   2. For each participant: find or create their org-owned Client record.
 *   3. Create the Participant, linking Client to Case with a role.
 *   4. Generate their assigned Requirements.
 *   5. Issue a Case Access grant + invitation token.
 *   6. Send the invitation (the OTP is dispatched when the client opens it).
 *   7. Return the new Case id so the caller can redirect to it.
 *
 * Runs entirely as the acting staff member, so RLS decides at every step whether the write is
 * allowed — a non-member cannot get past step 1.
 *
 * Partial-failure policy: a Case that exists with participants is more useful than a rollback, and
 * Postgres transactions do not span these client calls anyway. Invitation failures are collected
 * and reported rather than thrown, so the caller can show exactly who still needs inviting.
 */
export async function createCaseWithParticipants(
  client: DbClient,
  input: CreateCaseWithParticipantsInput,
  actorAuthUserId: string,
): Promise<CreatedCase> {
  let parsed;
  try {
    parsed = parseInput(createCaseWithParticipantsSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError("validation", "Revisa los datos del expediente.", error.issues);
    }
    throw error;
  }

  const { organizationId, title, blueprintId, participants, sendInvitations } = parsed;

  // Resolve every participant's durable Client record up front. `cases.client_id` predates the
  // Participant model and is still NOT NULL, so the Case needs one Client to be created with; the
  // first participant's is the natural choice. Participants remain the authority for access.
  const clientIds: string[] = [];
  for (const p of participants) {
    clientIds.push(
      await findOrCreateClient(client, {
        organizationId,
        fullName: p.fullName,
        email: p.email,
      }),
    );
  }

  // 1 · Create the Case (cloning the Blueprint's stages and requirement definitions when given).
  let caseId: string;
  try {
    caseId = await createCase(
      client,
      { organizationId, title, blueprintId, clientId: clientIds[0]! },
      actorAuthUserId,
    );
  } catch {
    throw new UseCaseError(
      "forbidden",
      "No pudimos crear el expediente. Verifica que tengas acceso a esta organización.",
    );
  }

  const created: CreatedCase["participants"] = [];
  const invitationFailures: CreatedCase["invitationFailures"] = [];

  for (const [index, p] of participants.entries()) {
    // 2 · The durable, org-owned Client record, resolved above (reused if the person exists here).
    const clientId = clientIds[index]!;

    // 3 · The Participant: this Client, in this Case, in this role.
    const participantId = await createParticipant(client, {
      organizationId,
      caseId,
      clientId,
      roleLabel: p.roleLabel,
    });

    // 4 · Their assigned Requirements. Only this participant will ever see them.
    let position = 0;
    for (const label of p.requirements) {
      await addRequirement(
        client,
        { organizationId, caseId, label, position: position++, participantId },
        actorAuthUserId,
      );
    }

    // 5 + 6 · Grant and invitation. A failure here does not undo the participant.
    let invited = false;
    if (sendInvitations) {
      try {
        await issueInvitation(
          client,
          { organizationId, caseId, participantId, permission: "upload" },
          actorAuthUserId,
        );
        invited = true;
      } catch (cause) {
        invitationFailures.push({
          email: p.email,
          reason: cause instanceof Error ? cause.message : "No se pudo enviar la invitación",
        });
      }
    }

    created.push({ id: participantId, name: p.fullName, email: p.email, role: p.roleLabel, invited });
  }

  await logDomainEvent(client, {
    organizationId,
    caseId,
    action: "case.created",
    targetType: "case",
    targetId: caseId,
    actor: { kind: "member", authUserId: actorAuthUserId },
    metadata: {
      participantCount: created.length,
      requirementCount: participants.reduce((n, p) => n + p.requirements.length, 0),
      fromBlueprint: blueprintId !== undefined,
      invitationsSent: created.filter((p) => p.invited).length,
    },
  });

  // 7 · The caller redirects to this.
  return { caseId, participants: created, invitationFailures };
}
