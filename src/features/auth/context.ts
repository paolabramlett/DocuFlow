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
 * user actually belongs to. Uses the first membership; multi-org switching is a later concern.
 * Server Actions use this (they surface an error rather than redirect); pages use requireStaff.
 */
export async function getStaffContext(): Promise<StaffContext | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("members")
    .select("role, organization:organizations(id, name, industry)")
    .limit(1)
    .maybeSingle();

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

/** Page guard: resolves the staff context or redirects to /login. */
export async function requireStaff(): Promise<StaffContext> {
  const context = await getStaffContext();
  if (!context) redirect("/login");
  return context;
}
