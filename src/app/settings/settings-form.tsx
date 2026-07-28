"use client";

import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconShield } from "@/components/icons";
import { updateOrganizationAction } from "./actions";
import type { UpdateOrganizationInput } from "@/application/update-organization";

const INDUSTRY_LABEL: Record<string, string> = {
  notary: "Notaría",
  accounting: "Contaduría",
  legal: "Legal",
  insurance: "Seguros",
  hr: "Recursos humanos",
  other: "Otro",
};

export function SettingsForm({
  name: initialName,
  industry: initialIndustry,
  isOwner,
  account,
}: {
  name: string;
  industry: string;
  isOwner: boolean;
  account: ShellAccount;
}) {
  const [name, setName] = useState(initialName);
  const [industry, setIndustry] = useState(initialIndustry);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  async function save() {
    setPending(true);
    setFeedback(null);
    // `industry` state can only ever hold one of INDUSTRY_LABEL's keys (the <select>'s only
    // options), which are exactly the use case's enum values — the DB column itself is a plain
    // `text` with a CHECK constraint, not a generated enum, so the wire type is `string` and this
    // cast just asserts what the closed option set already guarantees. The use case's Zod schema
    // still re-validates server-side regardless.
    const result = await updateOrganizationAction({
      name,
      industry: industry as UpdateOrganizationInput["industry"],
    });
    setPending(false);
    setConfirming(false);
    setFeedback(
      result.ok
        ? { ok: true, message: "Guardado." }
        : { ok: false, message: result.message },
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (industry !== initialIndustry) {
      setConfirming(true);
      return;
    }
    void save();
  }

  return (
    <AppShell active="settings" account={account}>
      <div className="flex h-16 shrink-0 items-center border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Configuración</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-lg rounded-card border border-border bg-surface p-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-5">
            <div>
              <label className="text-sm font-medium text-text-primary">Nombre de la organización</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isOwner}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary">Industria</label>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                disabled={!isOwner}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {Object.entries(INDUSTRY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {!isOwner && (
              <p className="text-xs text-text-secondary">Solo el propietario puede editar esta información.</p>
            )}

            {feedback && (
              <p className={`text-sm ${feedback.ok ? "text-success" : "text-error"}`}>{feedback.message}</p>
            )}

            {isOwner && (
              <button
                type="submit"
                disabled={pending}
                className="self-start rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Guardar"}
              </button>
            )}
          </form>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-royal-50 text-royal-600">
              <IconShield className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Confirmar cambio de industria</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Cambiar la industria no modifica los expedientes ni las plantillas que ya existen —
              solo afecta lo que se cree a partir de ahora.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={pending}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Confirmar y guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
