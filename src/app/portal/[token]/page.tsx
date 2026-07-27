/*
 * Client Portal entry — Server Component. See docs/CLIENT_PORTAL.md before changing anything
 * here: this page answers exactly one question ("what do I need to do next?") and must never
 * grow into a smaller mirror of the Staff workspace.
 *
 * Always tries the already-accepted path first. A Supabase session alone proves nothing about
 * THIS invitation (design.md D1: authorization comes from an accepted grant, never from being
 * logged in) — so re-resolving getPortalState on every load is what correctly skips straight to
 * the checklist for a returning client, and equally correctly falls back to the OTP flow for a
 * second, not-yet-accepted invitation to the same person.
 */

import { createClient } from "@/lib/supabase/server";
import { UseCaseError } from "@/application/errors";
import {
  getPortalState,
  resolveInvitation,
  type InvitationLanding,
  type PortalState,
} from "@/application/client-portal";
import { PortalClient } from "./portal-client";

export const dynamic = "force-dynamic";

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const supabase = await createClient();

  // A session alone proves nothing about THIS invitation (design.md D1), but no session at all
  // means the caller is still `anon` — a role that has no grant on case_access_grants at all, so
  // querying it would fail at the SQL permission layer, not as a RLS empty-result. Only attempt
  // the already-accepted path once a real session exists.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Data-fetch and JSX construction stay apart: a try/catch around returned JSX cannot actually
  // catch that child's render errors, only around the plain async call below, which is the
  // intent here.
  let checklistState: PortalState | null = null;
  if (user) {
    try {
      checklistState = await getPortalState(supabase, token);
    } catch (stateError) {
      // Only a recognized "not yet mine / not active" signal falls through to the invitation
      // landing. Anything else is a real failure and must render as one, not be silently masked.
      if (
        !(stateError instanceof UseCaseError) ||
        (stateError.reason !== "not_found" && stateError.reason !== "forbidden")
      ) {
        throw stateError;
      }
    }
  }

  if (checklistState) {
    return <PortalClient token={token} mode="checklist" initialState={checklistState} />;
  }

  let landing: InvitationLanding | null = null;
  let landingFailure: UseCaseError | null = null;
  try {
    landing = await resolveInvitation({ token });
  } catch (invitationError) {
    if (invitationError instanceof UseCaseError) {
      landingFailure = invitationError;
    } else {
      throw invitationError;
    }
  }

  if (landing) {
    return <PortalClient token={token} mode="landing" landing={landing} />;
  }

  return (
    <PortalClient
      token={token}
      mode="error"
      error={{ reason: landingFailure!.reason, message: landingFailure!.message }}
    />
  );
}
