/*
 * Clientes — Server Component. A read-only directory: Clients are still only ever created
 * through the "Nuevo expediente" wizard (findOrCreateClient); this page adds no second path.
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getClientsDirectory } from "@/features/clients/queries";
import { ClientsDirectory } from "./clients-directory";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const clients = await getClientsDirectory(supabase, staff.organizationId);

  return (
    <ClientsDirectory
      clients={clients}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
