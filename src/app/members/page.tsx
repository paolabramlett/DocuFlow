/*
 * Miembros — Server Component. A team directory: any active member can view it (product
 * decision, see docs/superpowers/specs/2026-07-27-staff-nav-pages-design.md). Only the "Invitar
 * miembro" control is owner-gated (see MembersDirectory in members-directory.tsx for the real
 * invite flow and src/application/invite-member.ts for its authorization).
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getOrganizationMembers } from "@/features/members/queries";
import { MembersDirectory } from "./members-directory";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const members = await getOrganizationMembers(supabase, staff.organizationId);

  return (
    <MembersDirectory
      members={members}
      isOwner={staff.role === "owner"}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
