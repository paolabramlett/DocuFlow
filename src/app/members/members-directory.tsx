"use client";

import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconMail } from "@/components/icons";
import type { MemberDirectoryRow } from "@/features/members/queries";

const ROLE_LABEL: Record<MemberDirectoryRow["role"], string> = {
  owner: "Propietario",
  staff: "Staff",
};

function formatMemberSince(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });
}

export function MembersDirectory({
  members,
  isOwner,
  account,
}: {
  members: MemberDirectoryRow[];
  isOwner: boolean;
  account: ShellAccount;
}) {
  return (
    <AppShell active="members" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Miembros</h1>
        {isOwner && (
          <div className="group relative ml-auto">
            <button
              type="button"
              disabled
              className="flex cursor-not-allowed items-center gap-2 rounded-input bg-royal-600/40 px-4 py-2 text-sm font-semibold text-white/70"
            >
              <IconMail className="size-4" /> Invitar miembro
            </button>
            <div className="pointer-events-none absolute right-0 top-full z-10 mt-2 w-56 rounded-input border border-border bg-surface px-3 py-2 text-xs text-text-secondary opacity-0 shadow-md transition-opacity group-hover:opacity-100">
              Próximamente: la invitación por correo estará disponible pronto.
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold tracking-tight text-text-primary">Miembros</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Todo el equipo de tu organización. Cualquier miembro puede ver este directorio.
          </p>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-app-bg text-xs font-semibold uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="px-5 py-3">Correo</th>
                <th className="px-5 py-3">Rol</th>
                <th className="px-5 py-3">Miembro desde</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-5 py-3 font-medium text-text-primary">{m.email}</td>
                  <td className="px-5 py-3 text-text-secondary">{ROLE_LABEL[m.role]}</td>
                  <td className="px-5 py-3 text-text-secondary">{formatMemberSince(m.memberSince)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
