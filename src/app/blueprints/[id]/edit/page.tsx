import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { countCasesUsingBlueprint, getBlueprintDefinition } from "@/features/blueprints/queries";
import { BlueprintEditor } from "../../blueprint-editor";

export const dynamic = "force-dynamic";

export default async function EditBlueprintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requireStaff();
  if (staff.role !== "owner") redirect("/blueprints");

  const { id } = await params;
  const client = await createClient();
  const definition = await getBlueprintDefinition(client, id, staff.organizationId);
  if (!definition) notFound();

  const usageCount = await countCasesUsingBlueprint(client, id, staff.organizationId);

  return (
    <BlueprintEditor
      mode="edit"
      blueprintId={id}
      initialBlueprint={definition}
      usageCount={usageCount}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
