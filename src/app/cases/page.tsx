/*
 * Cases workspace — Server Component. Resolves the signed-in staff member, reads their
 * Organization's cases through RLS, and hands the data to the interactive client shell.
 */

import { requireStaff } from "@/features/auth/context";
import { getOperativeCounts, getWorkspaceCases } from "@/features/cases/queries";
import { CasesWorkspace } from "./cases-workspace";

export const dynamic = "force-dynamic";

export default async function CasesPage() {
  const staff = await requireStaff();
  const cases = await getWorkspaceCases();
  const counts = await getOperativeCounts(cases);

  return (
    <CasesWorkspace
      cases={cases}
      counts={counts}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
