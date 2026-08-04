import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/types/database";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";
import { addRequirement, createCase } from "@/features/cases/cases";
import { createParticipant, findOrCreateClient } from "@/features/participants/participants";
import { issueInvitation } from "@/features/case-access/invitations";
import {
  BLUEPRINT_INTEGRITY_MESSAGES,
  BlueprintIntegrityError,
  getBlueprintDefinition,
  type BlueprintDefinition,
} from "@/features/blueprints/queries";
import { sendTransactionalEmail, type SendTransactionalEmailInput } from "@/lib/email/resend";
import { escapeHtml } from "@/lib/email/escape-html";
import { APP_ORIGIN } from "@/lib/supabase/env";

type DbClient = SupabaseClient<Database>;

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Two separate schemas, not one shared with a single max length: role_key's DB column allows only
// 100 chars (blueprint_participant_templates' own check constraint), requirement keys allow 200.
const roleKeySchema = z.string().trim().min(1).max(100)
  .regex(slugPattern, "Debe ser un identificador en formato slug");
const requirementKeySchema = z.string().trim().min(1).max(200)
  .regex(slugPattern, "Debe ser un identificador en formato slug");

// .strict() on both branches is what actually makes "manual participant cannot include
// blueprint-only fields" true — z.object() silently strips unknown keys by default rather than
// rejecting them.
const participantSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("blueprint"),
    participantTemplateRoleKey: roleKeySchema,
    roleLabel: z.string().trim().min(1, "Cada participante necesita un rol").max(100),
    fullName: z.string().trim().min(1, "Cada participante necesita un nombre").max(200),
    email: z.string().trim().toLowerCase().email("Revisa el correo electrónico").max(320),
    requirementKeys: z
      .array(requirementKeySchema)
      .refine((keys) => new Set(keys).size === keys.length, "Requisitos duplicados"),
  }).strict(),
  z.object({
    source: z.literal("manual"),
    roleLabel: z.string().trim().min(1, "Cada participante necesita un rol").max(100),
    fullName: z.string().trim().min(1, "Cada participante necesita un nombre").max(200),
    email: z.string().trim().toLowerCase().email("Revisa el correo electrónico").max(320),
    requirements: z.array(z.string().trim().min(1).max(300)), // unchanged freeform trust model
  }).strict(),
]);

export const createCaseWithParticipantsSchema = z.object({
  organizationId: z.string().uuid(),
  title: z.string().trim().min(1, "Ponle un título al expediente").max(300),
  blueprintId: z.string().uuid().optional(),
  participants: z.array(participantSchema).min(1, "Agrega al menos un participante"),
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
 *   1. If a Blueprint was chosen, fetch and strictly validate it — exactly once, regardless of
 *      whether any participant is actually source: 'blueprint'. A crafted/foreign blueprintId
 *      submitted alongside only manual participants must not skip this: it still reaches
 *      create_case's RPC clone below, so this fetch is what actually gates it.
 *   2. Create the Case — cloning the Blueprint's stages and case-scoped requirement definitions
 *      when one was chosen (deep copy; the Case is independent from that moment on).
 *   3. For each participant: find or create their org-owned Client record.
 *   4. Create the Participant, linking Client to Case with a role.
 *   5. Resolve their assigned Requirements — from the Blueprint's allowlist (client can narrow,
 *      never expand or invent) for a 'blueprint' participant, or freeform for a 'manual' one.
 *   6. Issue a Case Access grant + invitation token.
 *   7. Email the participant the Portal link (the OTP code itself is dispatched later, when the
 *      client opens that link and asks for it — this step only gets them there).
 *   8. Return the new Case id so the caller can redirect to it.
 *
 * Runs entirely as the acting staff member, so RLS decides at every step whether the write is
 * allowed — a non-member cannot get past step 2.
 *
 * NOT ATOMIC: this orchestrates multiple, separate Postgres calls. A failure partway through
 * leaves a partial Case rather than rolling back — there is no idempotency key, so blindly
 * resubmitting the same title/participants risks creating a second, duplicate Case rather than
 * resuming the first. Partial-failure policy for invitations specifically: a Case that exists
 * with participants is more useful than a rollback, and Postgres transactions do not span these
 * client calls anyway, so invitation failures are collected and reported rather than thrown.
 * TODO: move participant + requirement + case creation into a single RPC transaction once this
 * needs to be atomic.
 */
export async function createCaseWithParticipants(
  client: DbClient,
  input: CreateCaseWithParticipantsInput,
  actorAuthUserId: string,
  // Exists only for tests — production callers never pass it, matching inviteMember's own
  // sendEmail parameter (src/application/invite-member.ts).
  sendEmail: (input: SendTransactionalEmailInput) => Promise<void> = sendTransactionalEmail,
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

  let blueprintDefinition: BlueprintDefinition | null = null;
  if (blueprintId) {
    // getBlueprintDefinition re-validates the Blueprint's structural integrity on every read (not
    // just at save time) — including that every requirement's stage_position still resolves
    // against the Blueprint's own blueprint_stages. A Blueprint that fails this (e.g. edited into
    // an inconsistent state after being saved) must reject the Case outright, matching this
    // task's own "never silently drop to stage_id: null" rule (§6.1), rather than surfacing as an
    // opaque "unexpected" failure.
    try {
      blueprintDefinition = await getBlueprintDefinition(client, blueprintId, organizationId);
    } catch (error) {
      if (error instanceof BlueprintIntegrityError) {
        throw new UseCaseError(
          "validation",
          BLUEPRINT_INTEGRITY_MESSAGES[error.code] ?? "Los datos de la plantilla no son válidos.",
        );
      }
      throw error;
    }
    if (!blueprintDefinition) {
      throw new UseCaseError("not_found", "La plantilla ya no existe.");
    }
  }

  // Every participant-level input error is caught here, before any write happens — including the
  // role-key check, which needs blueprintDefinition but is still pure validation against data
  // already in hand. Doing this later, inside the write loop, would let a rejected request leave
  // a partial Case behind (its own Case row, cloned stages, and any already-created participants).
  const allowedByRole = new Map<string, Map<string, string>>();
  for (const p of participants) {
    if (p.source !== "blueprint") continue;
    if (!blueprintId) {
      throw new UseCaseError(
        "validation",
        "Un participante de plantilla requiere una plantilla seleccionada.",
      );
    }
    if (!allowedByRole.has(p.participantTemplateRoleKey)) {
      const roleExists = blueprintDefinition!.participantTemplates.some(
        (t) => t.roleKey === p.participantTemplateRoleKey,
      );
      if (!roleExists) {
        throw new UseCaseError("validation", "El rol de participante no existe en esta plantilla.");
      }
      allowedByRole.set(
        p.participantTemplateRoleKey,
        new Map(
          blueprintDefinition!.requirements
            .filter((r) => r.scope === "participant" && r.participantRoleKey === p.participantTemplateRoleKey)
            .map((r) => [r.key, r.label] as const),
        ),
      );
    }
  }

  // Resolve each participant-scoped Requirement definition's stage_position (if any) against the
  // Blueprint's own blueprint_stages, up front — this is validation, not a write, so a Case with a
  // dangling stage reference is never created (§6.1 of the design spec). Keyed by requirement key
  // since that's what requirementKeys/allowedByRole already use; case-scope definitions don't need
  // this (create_case's own SQL already resolves their stage_id during the clone).
  const stagePositionByRequirementKey = new Map<string, number>();
  if (blueprintDefinition) {
    for (const r of blueprintDefinition.requirements) {
      if (r.scope === "participant" && r.stagePosition !== null) {
        stagePositionByRequirementKey.set(r.key, r.stagePosition);
      }
    }
  }

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

  // Case-level lookup from stage_position -> the cloned case_stages.id, built once (not per
  // participant/requirement) since create_case already cloned every blueprint_stages row 1:1 into
  // case_stages with matching position, keyed by this same Case.
  const stagePositionToStageId = new Map<number, string>();
  if (blueprintId) {
    const { data: clonedStages } = await client
      .from("case_stages")
      .select("id, position")
      .eq("case_id", caseId);
    for (const s of clonedStages ?? []) {
      stagePositionToStageId.set(s.position, s.id);
    }
  }

  // Fetched once, outside the participant loop, purely for the invitation email's copy — never
  // gates access (RLS already decided the Case could be created at all, above).
  let organizationName = "Avanza";
  if (sendInvitations) {
    const { data: organization } = await client
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .single();
    if (organization) organizationName = organization.name;
  }

  const created: CreatedCase["participants"] = [];
  const invitationFailures: CreatedCase["invitationFailures"] = [];
  let totalRequirementCount = 0;

  for (const [index, p] of participants.entries()) {
    const clientId = clientIds[index]!;

    const participantId = await createParticipant(client, {
      organizationId,
      caseId,
      clientId,
      roleLabel: p.roleLabel,
    });

    // Resolve this participant's actual Requirement [key, label] pairs. For a 'blueprint'
    // participant, the Blueprint is the allowlist (already validated and precomputed above,
    // before any write): the client can narrow (deselect), never expand or invent — an unknown
    // key, or a key that exists only under a different role, is silently filtered out, never a
    // rejection of the whole request. The persisted label is always the Blueprint's own canonical
    // text, never anything the client sent. 'manual' participants keep today's existing,
    // unrestricted freeform behaviour, in every combination (alone, with an active Blueprint,
    // mixed with a 'blueprint' participant in the same Case) — their suggestions are a convenience
    // pool only; they are never bound to any role_key. Kept as [key, label] pairs (rather than
    // labels alone) so stage_position can be resolved per requirement below.
    let effectiveEntries: [string, string][];
    if (p.source === "manual") {
      effectiveEntries = p.requirements.map((label) => [label, label]);
    } else {
      const allowedByKey = allowedByRole.get(p.participantTemplateRoleKey)!;
      effectiveEntries = p.requirementKeys
        .filter((key) => allowedByKey.has(key))
        .map((key) => [key, allowedByKey.get(key)!]);
    }

    let position = 0;
    for (const [key, label] of effectiveEntries) {
      let stageId: string | undefined;
      const stagePosition = stagePositionByRequirementKey.get(key);
      if (stagePosition !== undefined) {
        stageId = stagePositionToStageId.get(stagePosition);
        if (stageId === undefined) {
          // A requirement definition names a stage_position that didn't survive the clone (e.g.
          // the Blueprint's blueprint_stages was edited between validation and this write, or the
          // position simply doesn't exist) — fail outright rather than silently dropping to
          // stage_id: null (§6.1: "stage_id = null is not an acceptable fallback" for a
          // Blueprint-derived requirement that specified a stage_position).
          throw new UseCaseError(
            "validation",
            "No pudimos ubicar la etapa de uno de los requisitos de esta plantilla. Revisa la configuración de etapas.",
          );
        }
      }
      await addRequirement(
        client,
        { organizationId, caseId, label, position: position++, participantId, stageId },
        actorAuthUserId,
      );
    }
    totalRequirementCount += effectiveEntries.length;

    let invited = false;
    if (sendInvitations) {
      try {
        const { token } = await issueInvitation(
          client,
          { organizationId, caseId, participantId, permission: "upload" },
          actorAuthUserId,
        );
        // issueInvitation only creates the grant; nothing tells the participant it exists unless
        // this email actually reaches them. A failure here must count as an invitation failure
        // too (not a best-effort notification like inviteMember's "you were added" email) — an
        // "invited" participant with no way to learn the Portal URL exists cannot access anything.
        await sendEmail({
          to: p.email,
          subject: `Te invitaron a completar tu expediente — ${organizationName}`,
          html: `<h2>Te invitaron a completar tu expediente</h2>\n<p>${escapeHtml(organizationName)} te invitó a completar información en Avanza. Usa el siguiente enlace para continuar:</p>\n<p><a href="${APP_ORIGIN}/portal/${token}">Ir a mi expediente</a></p>\n<p>No necesitas crear una cuenta — solo abre el enlace y sigue las instrucciones.</p>`,
          idempotencyKey: `case-invitation/${caseId}/${participantId}`,
        });
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
      requirementCount: totalRequirementCount,
      fromBlueprint: blueprintId !== undefined,
      invitationsSent: created.filter((p) => p.invited).length,
    },
  });

  return { caseId, participants: created, invitationFailures };
}
