import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

/**
 * The Client Portal's read model — deliberately its own, not a reuse of the Staff workspace query
 * (src/features/cases/queries.ts). The two are allowed to diverge: Staff needs every Participant
 * and the full Case; a Client needs only their own actionable list. Coupling them would make the
 * portal a shrunken mirror of the Staff panel instead of its own thing.
 *
 * Runs entirely through RLS as the authenticated Participant. A Client's read of
 * `case_participants` and `requirements` is already scoped by `granted_participant_ids` at the
 * database, so this can only ever return the caller's own Case and their own Requirements —
 * enforced independently of anything this file does (participant-isolation.test.ts).
 */

export type PortalReqState = 'pending' | 'review' | 'approved' | 'rejected';

export interface PortalRequirement {
  readonly id: string;
  readonly label: string;
  readonly state: PortalReqState;
  readonly rejectionReason?: string;
  /** The latest Document's id/name — present whenever one exists, regardless of state, so the
   *  client can always see what they last submitted. Only 'approved' rows show it in the UI. */
  readonly documentId?: string;
  readonly fileName?: string;
  /** Set only when `state === 'approved'`: the moment the approving review was recorded. */
  readonly approvedAt?: string;
  /** Present only for a Requirement belonging to a stage; used to group into "Correcciones
   *  pendientes" vs. the active stage's own list. A 'locked' stage's Requirements never reach
   *  this far — getPortalCase filters them out via `list_participant_stage_context` (a security
   *  definer RPC), since case_stages' own RLS is staff-only and an embedded join from the
   *  Portal's Participant session would otherwise silently resolve to null (never an error). */
  readonly stageStatus?: 'locked' | 'active' | 'completed';
  /** The original stage's name, shown next to a reopened item so the client has the same context
   *  Staff sees ("(Kick-Off)"). Present only when reopenedFromRequirementId is set. */
  readonly originalStageName?: string;
  readonly reopenedFromRequirementId: string | null;
  /** Staff's own note on why this item was reopened for correction (reopen_requirement's
   *  `reopen_reason`). Present only alongside a set reopenedFromRequirementId. */
  readonly reopenReason?: string;
}

export interface PortalCase {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly caseState: 'open' | 'completed' | 'cancelled';
  readonly clientClosingNote?: string;
  readonly requirements: PortalRequirement[];
}

interface RawReview {
  decision: string;
  reason: string | null;
  created_at: string;
}
interface RawDocument {
  id: string;
  file_name: string;
  created_at: string;
  reviews: RawReview[];
}
interface RawRequirement {
  id: string;
  label: string;
  position: number;
  status: string;
  stage_id: string | null;
  reopened_from_requirement_id: string | null;
  reopen_reason: string | null;
  documents: RawDocument[];
}

interface StageContext {
  stageStatus: 'locked' | 'active' | 'completed';
  stageName: string;
}

interface DerivedState {
  state: PortalReqState;
  rejectionReason?: string;
  documentId?: string;
  fileName?: string;
  approvedAt?: string;
}

function deriveState(r: RawRequirement): DerivedState {
  const latestDocument = [...r.documents].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];
  const docFields = latestDocument
    ? { documentId: latestDocument.id, fileName: latestDocument.file_name }
    : {};

  if (r.status === 'satisfied') {
    // Scoped to the latest Document's own reviews, same reasoning as the rejection case below —
    // the approving review is the one on the Document that actually satisfied the Requirement.
    const approvingReview = [...(latestDocument?.reviews ?? [])]
      .filter((rev) => rev.decision === 'approved')
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    return { state: 'approved', approvedAt: approvingReview?.created_at, ...docFields };
  }

  // Scoped to the latest Document's own reviews — a rejected review on a superseded Document must
  // never keep outvoting a newer, not-yet-reviewed re-upload (that re-upload has no reviews at
  // all, so comparing across all Documents would always find the old rejection "latest").
  const latestReview = [...(latestDocument?.reviews ?? [])].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];

  if (latestReview?.decision === 'rejected') {
    return { state: 'rejected', rejectionReason: latestReview.reason ?? undefined, ...docFields };
  }
  if (r.documents.length > 0) return { state: 'review', ...docFields };
  return { state: 'pending' };
}

/** Orders the checklist so what needs action surfaces before what is already handled. */
const STATE_ORDER: Record<PortalReqState, number> = { rejected: 0, pending: 1, review: 2, approved: 3 };

/**
 * Reads the signed-in Participant's own Case: its Organization name, title, and their assigned
 * Requirements — pending-first. Returns null if the Participant row itself is not visible (the
 * grant is not active, or belongs to someone else; both look identical, by design).
 */
export async function getPortalCase(client: DbClient, participantId: string): Promise<PortalCase | null> {
  const { data, error } = await client
    .from('case_participants')
    .select(
      `case:cases(title, state, client_closing_note, organization:organizations(name)),
       requirements(id, label, position, status, deleted_at, superseded_at,
         stage_id, reopened_from_requirement_id, reopen_reason,
         documents(id, file_name, created_at, reviews(decision, reason, created_at)))`,
    )
    .eq('id', participantId)
    .maybeSingle();

  if (error) throw new Error(`getPortalCase: ${error.message}`);
  if (!data?.case) return null;

  // case_stages' own SELECT policy is staff-only (case_stages_select_by_member); an embedded join
  // from this (Participant) session would silently resolve to null under RLS, never an error. This
  // security-definer RPC — explicitly re-gated against app.granted_participant_ids — bridges that
  // gap the same way app.actionable_requirement_ids does for the reminder selector.
  const { data: stageContextRows, error: stageContextError } = await client.rpc(
    'list_participant_stage_context',
    { p_participant_id: participantId },
  );
  if (stageContextError) throw new Error(`getPortalCase: ${stageContextError.message}`);

  const stageContextById = new Map<string, StageContext>(
    (stageContextRows ?? []).map((row) => [
      row.requirement_id,
      { stageStatus: row.stage_status as 'locked' | 'active' | 'completed', stageName: row.stage_name },
    ]),
  );

  const requirements = (data.requirements ?? [])
    .filter((r) => !r.deleted_at && !r.superseded_at)
    .map((r) => {
      const raw = r as RawRequirement;
      const derived = deriveState(raw);
      const stageContext = stageContextById.get(r.id);
      return {
        id: r.id,
        label: r.label,
        state: derived.state,
        rejectionReason: derived.rejectionReason,
        documentId: derived.documentId,
        fileName: derived.fileName,
        approvedAt: derived.approvedAt,
        stageStatus: stageContext?.stageStatus,
        // Only meaningful next to a reopened item — a reopened row always carries its original
        // (necessarily 'completed') stage's own stage_id, per reopen_requirement's own guard, so
        // this needs no separate lookup: the row's own stage context IS that original stage.
        originalStageName: raw.reopened_from_requirement_id !== null ? stageContext?.stageName : undefined,
        reopenedFromRequirementId: raw.reopened_from_requirement_id,
        reopenReason: raw.reopen_reason ?? undefined,
      };
    })
    // A 'locked' future stage's Requirements are never shown to the client at all — not even to
    // count toward pendingCount — so the Portal can't spoil what's coming next. A requirement with
    // NO stage context entry (stage_id was null — no stage at all) is NOT locked and stays
    // included: that's the "Case has no workflow" / legacy "Sin etapa" case, always actionable.
    // Nothing else needs to filter this out downstream once it's gone here.
    .filter((r) => r.stageStatus !== 'locked')
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  return {
    organizationName: data.case.organization?.name ?? '',
    caseTitle: data.case.title,
    caseState: data.case.state as 'open' | 'completed' | 'cancelled',
    clientClosingNote: data.case.client_closing_note ?? undefined,
    requirements,
  };
}
