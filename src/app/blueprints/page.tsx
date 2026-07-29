/*
 * Plantillas — Server Component. A read-only library: Blueprints are still only ever created
 * outside the app (seed data, or directly in the database) — this page adds no create/edit path.
 * See docs/superpowers/specs/2026-07-29-blueprint-selector-design.md for what's deliberately
 * deferred (owner-facing authoring UI).
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
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
