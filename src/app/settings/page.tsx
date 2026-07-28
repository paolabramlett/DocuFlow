import { requireStaff } from "@/features/auth/context";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const staff = await requireStaff();

  return (
    <SettingsForm
      name={staff.organizationName}
      industry={staff.organizationIndustry}
      isOwner={staff.role === "owner"}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
