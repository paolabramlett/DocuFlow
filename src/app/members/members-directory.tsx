"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconMail } from "@/components/icons";
import type { MemberDirectoryRow } from "@/features/members/queries";
import { inviteMemberAction } from "./actions";

const ROLE_LABEL: Record<MemberDirectoryRow["role"], string> = {
  owner: "Propietario",
  staff: "Staff",
};

export function MembersDirectory({
  members,
  isOwner,
  account,
}: {
  members: MemberDirectoryRow[];
  isOwner: boolean;
  account: ShellAccount;
}) {
  const router = useRouter();
  const [modalOpen, setModalOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result = await inviteMemberAction(email);
    setPending(false);
    if (result.ok) {
      setModalOpen(false);
      setEmail("");
      router.refresh();
    } else {
      setError(result.message);
    }
  }

  function closeModal() {
    setModalOpen(false);
    setEmail("");
    setError(null);
  }

  return (
    <AppShell active="members" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Miembros</h1>
        {isOwner && (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="ml-auto flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700"
          >
            <IconMail className="size-4" /> Invitar miembro
          </button>
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
                  <td className="px-5 py-3 text-text-secondary">{m.memberSince}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <h2 className="text-base font-semibold text-text-primary">Invitar miembro</h2>
            <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Correo electrónico</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  className="w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100"
                />
              </label>

              {error && <p className="text-sm text-error">{error}</p>}

              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
                >
                  {pending ? "Enviando…" : "Enviar invitación"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppShell>
  );
}
