import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getBlueprintDefinition } from "@/features/blueprints/queries";
import { BlueprintEditor } from "../blueprint-editor";

export const dynamic = "force-dynamic";

export default async function NewBlueprintPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const staff = await requireStaff();
  if (staff.role !== "owner") redirect("/blueprints");

  const { from } = await searchParams;
  const account = { name: staff.organizationName, sub: staff.email };

  if (from) {
    const client = await createClient();
    const definition = await getBlueprintDefinition(client, from, staff.organizationId);
    if (!definition) notFound();
    return (
      <BlueprintEditor mode="duplicate" initialBlueprint={definition} usageCount={0} account={account} />
    );
  }

  return <BlueprintEditor mode="create" initialBlueprint={null} usageCount={0} account={account} />;
}
