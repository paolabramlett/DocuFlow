import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface StaffContext {
  readonly userId: string;
  readonly email: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: "owner" | "staff";
}

/**
 * Resolves the signed-in staff member and their active Organization, or redirects to /login.
 *
 * Reads membership through RLS as the caller — so it can only ever report an Organization the
 * user actually belongs to. Uses the first membership; multi-org switching is a later concern.
 */
export async function requireStaff(): Promise<StaffContext> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("members")
    .select("role, organization:organizations(id, name)")
    .limit(1)
    .maybeSingle();

  if (!membership?.organization) redirect("/login");

  const role = membership.role === "owner" ? "owner" : "staff";
  return {
    userId: user.id,
    email: user.email ?? "",
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
    role,
  };
}
