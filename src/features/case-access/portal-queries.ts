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
}

export interface PortalCase {
  readonly organizationName: string;
  readonly caseTitle: string;
  readonly requirements: PortalRequirement[];
}

interface RawReview {
  decision: string;
  reason: string | null;
  created_at: string;
}
interface RawDocument {
  created_at: string;
  reviews: RawReview[];
}
interface RawRequirement {
  id: string;
  label: string;
  position: number;
  status: string;
  documents: RawDocument[];
}

function deriveState(r: RawRequirement): { state: PortalReqState; rejectionReason?: string } {
  if (r.status === 'satisfied') return { state: 'approved' };

  const latestDocument = [...r.documents].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];

  // Scoped to the latest Document's own reviews — a rejected review on a superseded Document must
  // never keep outvoting a newer, not-yet-reviewed re-upload (that re-upload has no reviews at
  // all, so comparing across all Documents would always find the old rejection "latest").
  const latestReview = [...(latestDocument?.reviews ?? [])].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0];

  if (latestReview?.decision === 'rejected') {
    return { state: 'rejected', rejectionReason: latestReview.reason ?? undefined };
  }
  if (r.documents.length > 0) return { state: 'review' };
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
      `case:cases(title, organization:organizations(name)),
       requirements(id, label, position, status, deleted_at, superseded_at,
         documents(created_at, reviews(decision, reason, created_at)))`,
    )
    .eq('id', participantId)
    .maybeSingle();

  if (error) throw new Error(`getPortalCase: ${error.message}`);
  if (!data?.case) return null;

  const requirements = (data.requirements ?? [])
    .filter((r) => !r.deleted_at && !r.superseded_at)
    .map((r) => {
      const derived = deriveState(r as RawRequirement);
      return { id: r.id, label: r.label, state: derived.state, rejectionReason: derived.rejectionReason };
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  return {
    organizationName: data.case.organization?.name ?? '',
    caseTitle: data.case.title,
    requirements,
  };
}
