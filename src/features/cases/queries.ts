import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { zonedDayBoundaryToUtc } from "@/lib/time/zoned-day-boundary";

type DbClient = SupabaseClient<Database>;

/**
 * Read models for the Cases workspace. Everything is fetched through RLS as the signed-in staff
 * member, so a query can only ever return the caller's Organization.
 *
 * The stored model is minimal (a Requirement is outstanding or satisfied); the UI's richer display
 * states are derived here from documents and reviews:
 *   satisfied                         -> approved
 *   outstanding + latest review reject -> rejected (with reason)
 *   outstanding + has a document       -> review
 *   outstanding + no document          -> missing
 */

export type ReqDisplayState = "approved" | "review" | "awaiting" | "rejected" | "missing";
export type StageStatus = "locked" | "active" | "completed";

export interface RequirementView {
  id: string;
  label: string;
  state: ReqDisplayState;
  rejectionReason?: string;
  /** The most recent Document awaiting or having received a decision, if any was uploaded. */
  documentId?: string;
  /** null when the Case has no workflow, OR when this is a legacy "Sin etapa" requirement inside
   *  a Case that does have one. Both render outside any stage grouping in the UI. */
  stageId: string | null;
  /** Present only on a row created by reopen_requirement — the label the client sees is unchanged
   *  from the original, but the UI needs this to render it under "Correcciones pendientes". */
  reopenedFromRequirementId: string | null;
}
export interface ParticipantView {
  id: string;
  name: string;
  role: string;
  requirements: RequirementView[];
}
export interface StageView {
  id: string;
  name: string;
  position: number;
  status: StageStatus;
  completionMode: "requirements" | "manual";
}
export interface CaseView {
  id: string;
  ref: string;
  title: string;
  opened: string;
  state: string;
  closedAt?: string;
  clientClosingNote?: string;
  participants: ParticipantView[];
  /** Empty array = this Case has no workflow (legacy flat behavior everywhere in the UI). */
  stages: StageView[];
}

function refFromId(id: string): string {
  return `CASE-${id.slice(0, 8).toUpperCase()}`;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

interface RawReview {
  decision: string;
  reason: string | null;
  created_at: string;
}
interface RawDocument {
  id: string;
  created_at: string;
  reviews: RawReview[];
}
interface RawRequirement {
  id: string;
  label: string;
  status: string;
  position: number;
  participant_id: string | null;
  stage_id: string | null;
  reopened_from_requirement_id: string | null;
  documents: RawDocument[];
}
interface RawStage {
  id: string;
  name: string;
  position: number;
  status: StageStatus;
  completion_mode: "requirements" | "manual";
}

function deriveState(
  r: RawRequirement,
): { state: ReqDisplayState; rejectionReason?: string; documentId?: string } {
  const latestDocument = [...r.documents].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];

  if (r.status === "satisfied") return { state: "approved", documentId: latestDocument?.id };

  // Scoped to the latest Document's own reviews — a rejected review on a superseded Document must
  // never keep outvoting a newer, not-yet-reviewed re-upload (that re-upload has no reviews at
  // all, so comparing across all Documents would always find the old rejection "latest").
  const latestReview = [...(latestDocument?.reviews ?? [])].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];

  if (latestReview?.decision === "rejected") {
    return { state: "rejected", rejectionReason: latestReview.reason ?? undefined, documentId: latestDocument?.id };
  }
  if (r.documents.length > 0) return { state: "review", documentId: latestDocument?.id };
  return { state: "awaiting" };
}

/**
 * The full workspace: every open/active case with its participants and their requirements, ordered
 * for display. One query with nested selects; RLS scopes it to the caller's Organization.
 */
export async function getWorkspaceCases(): Promise<CaseView[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("cases")
    .select(
      `id, title, state, created_at, closed_at, client_closing_note,
       stages:case_stages(id, name, position, status, completion_mode),
       participants:case_participants(id, role_label, client:clients(full_name),
         requirements(id, label, status, position, participant_id, deleted_at, superseded_at,
           stage_id, reopened_from_requirement_id,
           documents(id, created_at, reviews(decision, reason, created_at)))
       )`,
    )
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getWorkspaceCases: ${error.message}`);

  return (data ?? []).map((c) => ({
    id: c.id,
    ref: refFromId(c.id),
    title: c.title,
    opened: formatDate(c.created_at),
    state: c.state,
    closedAt: c.closed_at ?? undefined,
    clientClosingNote: c.client_closing_note ?? undefined,
    stages: ((c.stages ?? []) as RawStage[])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        name: s.name,
        position: s.position,
        status: s.status,
        completionMode: s.completion_mode,
      })),
    participants: (c.participants ?? []).map((p) => ({
      id: p.id,
      name: p.client?.full_name ?? "—",
      role: p.role_label,
      requirements: (p.requirements ?? [])
        .filter((r) => !r.deleted_at && !r.superseded_at)
        .sort((a, b) => a.position - b.position)
        .map((r) => {
          const derived = deriveState(r as RawRequirement);
          return {
            id: r.id,
            label: r.label,
            state: derived.state,
            rejectionReason: derived.rejectionReason,
            documentId: derived.documentId,
            stageId: (r as RawRequirement).stage_id,
            reopenedFromRequirementId: (r as RawRequirement).reopened_from_requirement_id,
          };
        }),
    })),
  }));
}

/** Operative counts for the summary strip. */
export interface OperativeCounts {
  waitingClient: number;
  needsReview: number;
  readyToContinue: number;
  completedToday: number;
}

export async function getOperativeCounts(
  client: DbClient,
  organizationId: string,
  cases: CaseView[],
): Promise<OperativeCounts> {
  let waitingClient = 0;
  let needsReview = 0;
  let readyToContinue = 0;
  for (const c of cases) {
    if (c.state !== "open") continue;
    const reqs = c.participants.flatMap((p) => p.requirements);
    if (reqs.some((r) => r.state === "review")) needsReview += 1;
    if (reqs.some((r) => r.state === "awaiting" || r.state === "missing" || r.state === "rejected")) waitingClient += 1;
    if (reqs.length > 0 && reqs.every((r) => r.state === "approved")) readyToContinue += 1;
  }

  // A real database COUNT, not a client-side filter over every already-fetched Case — the day
  // boundary is the only thing computed in TypeScript, using the real IANA timezone database
  // (never a hardcoded offset). America/Mexico_City is a fixed, product-wide zone for this MVP,
  // not per-organization — a deliberate, documented simplification.
  const now = new Date();
  const startOfTodayUtc = zonedDayBoundaryToUtc(now, "America/Mexico_City", 0);
  const startOfTomorrowUtc = zonedDayBoundaryToUtc(now, "America/Mexico_City", 1);

  const { count, error } = await client
    .from("cases")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("state", "completed")
    .gte("closed_at", startOfTodayUtc.toISOString())
    .lt("closed_at", startOfTomorrowUtc.toISOString());

  if (error) throw new Error(`getOperativeCounts: ${error.message}`);
  return { waitingClient, needsReview, readyToContinue, completedToday: count ?? 0 };
}

/** currentStageComplete per §5 of the design spec: is the active stage ready to advance? Read-only
 *  mirror of advance_case_stage's own gates, for disabling the "Continuar" button with a specific
 *  reason before the user even clicks it — the RPC remains the actual authority. */
export function currentStageAdvanceBlocker(c: CaseView): string | null {
  if (c.stages.length === 0) return "Este expediente no tiene un flujo por etapas.";
  const active = c.stages.find((s) => s.status === "active");
  if (!active) return "No hay una etapa activa.";

  const unassigned = c.participants
    .flatMap((p) => p.requirements)
    .some((r) => r.stageId === null && r.state !== "approved");
  if (unassigned) return "Hay requisitos sin etapa asignada. Resuélvelos en la sección Sin etapa.";

  const reopenedPending = c.participants
    .flatMap((p) => p.requirements)
    .some((r) => r.reopenedFromRequirementId !== null && r.state !== "approved");
  if (reopenedPending) return "Hay una corrección pendiente de una etapa anterior.";

  const activeStageReqs = c.participants
    .flatMap((p) => p.requirements)
    .filter((r) => r.stageId === active.id);
  const outstanding = activeStageReqs.filter((r) => r.state !== "approved");
  if (outstanding.length > 0) {
    return `Faltan ${outstanding.length} requisito${outstanding.length === 1 ? "" : "s"} de la etapa actual.`;
  }
  if (active.completionMode === "requirements" && activeStageReqs.length === 0) {
    return "Esta etapa no tiene requisitos configurados.";
  }
  return null;
}

/** workflowDocumentationComplete per §5: every stage completed, no reopened-pending, no
 *  unassigned-pending, anywhere in the Case. Empty stages array (no workflow) is never "complete"
 *  in this sense — that concept simply doesn't apply, so callers must check c.stages.length first. */
export function workflowDocumentationComplete(c: CaseView): boolean {
  if (c.stages.length === 0) return false;
  if (c.stages.some((s) => s.status !== "completed")) return false;
  const allReqs = c.participants.flatMap((p) => p.requirements);
  if (allReqs.some((r) => r.stageId === null && r.state !== "approved")) return false;
  if (allReqs.some((r) => r.reopenedFromRequirementId !== null && r.state !== "approved")) return false;
  // Defensive: every Stage is already confirmed "completed" above, so any Requirement carrying a
  // real stageId lives in a completed Stage. Trusting only reopenedFromRequirementId would miss
  // debt from a Requirement added directly to an already-completed Stage (never reopened, never
  // unassigned) — this catches it regardless of how it got there.
  if (allReqs.some((r) => r.stageId !== null && r.state !== "approved")) return false;
  return true;
}
