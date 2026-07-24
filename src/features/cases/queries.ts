import { createClient } from "@/lib/supabase/server";

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

export interface RequirementView {
  id: string;
  label: string;
  state: ReqDisplayState;
  rejectionReason?: string;
}
export interface ParticipantView {
  id: string;
  name: string;
  role: string;
  requirements: RequirementView[];
}
export interface CaseView {
  id: string;
  ref: string;
  title: string;
  opened: string;
  state: string;
  participants: ParticipantView[];
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
  reviews: RawReview[];
}
interface RawRequirement {
  id: string;
  label: string;
  status: string;
  position: number;
  participant_id: string | null;
  documents: RawDocument[];
}

function deriveState(r: RawRequirement): { state: ReqDisplayState; rejectionReason?: string } {
  if (r.status === "satisfied") return { state: "approved" };

  const latestReview = r.documents
    .flatMap((d) => d.reviews)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];

  if (latestReview?.decision === "rejected") {
    return { state: "rejected", rejectionReason: latestReview.reason ?? undefined };
  }
  if (r.documents.length > 0) return { state: "review" };
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
      `id, title, state, created_at,
       participants:case_participants(id, role_label, client:clients(full_name),
         requirements(id, label, status, position, participant_id, deleted_at, superseded_at,
           documents(id, reviews(decision, reason, created_at)))
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
    participants: (c.participants ?? []).map((p) => ({
      id: p.id,
      name: p.client?.full_name ?? "—",
      role: p.role_label,
      requirements: (p.requirements ?? [])
        .filter((r) => !r.deleted_at && !r.superseded_at)
        .sort((a, b) => a.position - b.position)
        .map((r) => {
          const derived = deriveState(r as RawRequirement);
          return { id: r.id, label: r.label, state: derived.state, rejectionReason: derived.rejectionReason };
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

export async function getOperativeCounts(cases: CaseView[]): Promise<OperativeCounts> {
  let waitingClient = 0;
  let needsReview = 0;
  let readyToContinue = 0;
  for (const c of cases) {
    const reqs = c.participants.flatMap((p) => p.requirements);
    if (reqs.some((r) => r.state === "review")) needsReview += 1;
    if (reqs.some((r) => r.state === "awaiting" || r.state === "missing" || r.state === "rejected")) waitingClient += 1;
    if (reqs.length > 0 && reqs.every((r) => r.state === "approved")) readyToContinue += 1;
  }
  return { waitingClient, needsReview, readyToContinue, completedToday: 0 };
}
