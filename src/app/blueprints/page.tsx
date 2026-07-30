/*
 * Plantillas — Server Component. Owners get authoring controls (Nueva plantilla, Editar,
 * Duplicar, Eliminar); any staff member can still browse the directory read-only.
 * See docs/superpowers/specs/2026-07-29-blueprint-authoring-design.md.
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { listBlueprintSummaries } from "@/features/blueprints/queries";
import { BlueprintsDirectory } from "./blueprints-directory";

export const dynamic = "force-dynamic";

export default async function BlueprintsPage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const blueprints = await listBlueprintSummaries(supabase, staff.organizationId);

  return (
    <BlueprintsDirectory
      blueprints={blueprints}
      isOwner={staff.role === "owner"}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
