import type { CaseView } from "@/features/cases/queries";

/**
 * Pure workflow rules over an already-fetched CaseView — no Supabase client, no `next/headers`,
 * nothing server-only. Deliberately split out of queries.ts: cases-workspace.tsx ("use client")
 * needs `currentStageAdvanceBlocker` at render time, and a value import from queries.ts (which
 * imports `createClient` from "@/lib/supabase/server" at module scope) drags that server-only
 * module into the client bundle — Turbopack then fails the whole /cases page at runtime with
 * "next/headers ... only available in Server Components". Only type-only imports from queries.ts
 * are safe in a client component; this module exists so the actual function bodies never live
 * anywhere near that import.
 */

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
