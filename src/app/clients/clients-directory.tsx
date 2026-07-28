"use client";

import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconSearch } from "@/components/icons";
import type { ClientDirectoryRow } from "@/features/clients/queries";

export function ClientsDirectory({
  clients,
  account,
}: {
  clients: ClientDirectoryRow[];
  account: ShellAccount;
}) {
  const [query, setQuery] = useState("");

  const filtered = clients.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return c.fullName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
  });

  return (
    <AppShell active="clients" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <div className="relative w-full max-w-sm">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar clientes…"
            className="w-full rounded-input border border-border bg-app-bg py-2 pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Clientes</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Directorio de clientes de tu organización. Se crean automáticamente al agregarlos a un
            expediente nuevo.
          </p>
        </div>

        {clients.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Aún no tienes clientes. Aparecerán aquí cuando crees tu primer expediente.
          </p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-text-secondary">
            No se encontraron clientes para «{query}».
          </p>
        ) : (
          <div className="overflow-hidden rounded-card border border-border bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-app-bg text-xs font-semibold uppercase tracking-wider text-text-secondary">
                <tr>
                  <th className="px-5 py-3">Nombre</th>
                  <th className="px-5 py-3">Correo</th>
                  <th className="px-5 py-3">Expedientes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td className="px-5 py-3 font-medium text-text-primary">{c.fullName}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.email}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.caseCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
