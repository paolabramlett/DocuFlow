/*
 * Nuevo expediente — Server Component. Fetches the real Blueprint list once, server-side, and
 * hands it to the interactive wizard. See new-case-wizard.tsx for the flow itself.
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { listBlueprintSummaries } from "@/features/blueprints/queries";
import { NewCaseWizard } from "./new-case-wizard";

export const dynamic = "force-dynamic";

export default async function NewCasePage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const blueprints = await listBlueprintSummaries(supabase, staff.organizationId);

  return (
    <NewCaseWizard
      blueprints={blueprints}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
