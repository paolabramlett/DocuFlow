import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface StaffContext {
  readonly userId: string;
  readonly email: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationIndustry: string;
  readonly role: "owner" | "staff";
}

/**
 * Resolves the signed-in staff member and their active Organization, or null.
 *
 * Reads membership through RLS as the caller — so it can only ever report an Organization the
 * user actually belongs to. Ordered by oldest membership first: since one identity can hold
 * multiple memberships (PRODUCT.md's "one identity, many organizations"), this is a stable pick,
 * not a solution to a future active-organization selector (out of scope here).
 * Server Actions use this (they surface an error rather than redirect); pages use requireStaff.
 *
 * Throws on a genuine query failure rather than returning null — an unexpected database error
 * must never be misread as "no organization yet", especially now that null can also route an
 * authenticated user to /onboarding rather than just /login.
 */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership, error } = await supabase
    .from("members")
    .select("role, organization:organizations(id, name, industry)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getStaffContext: ${error.message}`);
  if (!membership?.organization) return null;

  return {
    userId: user.id,
    email: user.email ?? "",
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
    organizationIndustry: membership.organization.industry,
    role: membership.role === "owner" ? "owner" : "staff",
  };
}

/**
 * Pure redirect decision for requireStaff — separated from the actual redirect() call so the
 * full state matrix (no session / session-no-org / session-with-org) is unit-testable without a
 * Next.js request context.
 *
 * A real Supabase session with no `members` row is not only "staff mid-onboarding" — it is also
 * the exact shape of a Portal Client session (src/features/case-access/invitations.ts's
 * signInWithOtp/verifyOtp flow never inserts a `members` row). Routing that state to /onboarding
 * rather than /login is a deliberate, user-approved decision, not an oversight: RLS isn't breached
 * (a Client could already self-serve a new Organization via /signup with any email regardless),
 * but the correct fix — a real classification of authenticated-identity kinds — is deliberately
 * out of scope here and deferred to its own design. Do not "fix" this by special-casing Clients
 * without that broader design; see docs/superpowers/specs/2026-07-30-signup-onboarding-design.md.
 */
export function resolveStaffRedirect(
  context: StaffContext | null,
  hasSession: boolean,
): "/login" | "/onboarding" | null {
  if (context) return null;
  return hasSession ? "/onboarding" : "/login";
}

/** Page guard: resolves the staff context, or redirects to /login (no session) or /onboarding
 *  (authenticated, no organization yet — a legitimate, persistent state, not an error). */
export async function requireStaff(): Promise<StaffContext> {
  const context = await getStaffContext();
  if (context) return context;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const target = resolveStaffRedirect(context, user !== null);
  if (target) redirect(target);
  // Unreachable: resolveStaffRedirect(null, ...) always returns a non-null path.
  throw new Error("unreachable");
}

/** Pure redirect decision for requireOnboarding — same testability rationale as
 *  resolveStaffRedirect. */
export function resolveOnboardingRedirect(
  hasSession: boolean,
  alreadyStaff: boolean,
): "/login" | "/cases" | null {
  if (!hasSession) return "/login";
  if (alreadyStaff) return "/cases";
  return null;
}

/** Page guard for /onboarding: requires a session but NO existing organization — redirects to
 *  /login if unauthenticated, /cases if onboarding was already completed. */
export async function requireOnboarding(): Promise<{ userId: string; email: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const alreadyStaff = user !== null && (await getStaffContext()) !== null;
  const target = resolveOnboardingRedirect(user !== null, alreadyStaff);
  if (target) redirect(target);

  return { userId: user!.id, email: user!.email ?? "" };
}
