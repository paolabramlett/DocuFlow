"use client";

/*
 * DocuFlow — Blueprint Library. Real data. Cards show the four broken-out counts; owners also get
 * Editar/Duplicar/Eliminar per card and a Nueva plantilla button.
 */

import Link from "next/link";
import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconDocument, IconPlus, IconTrash } from "@/components/icons";
import type { BlueprintSummary } from "@/features/blueprints/queries";
import { deleteBlueprintAction } from "./actions";

function BlueprintCard({
  b,
  isOwner,
  onDelete,
}: {
  b: BlueprintSummary;
  isOwner: boolean;
  onDelete: (b: BlueprintSummary) => void;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-input bg-royal-50 text-royal-600">
            <IconDocument className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold text-text-primary">{b.name}</div>
            {b.isPlatformTemplate && (
              <span className="mt-0.5 inline-block rounded-full bg-app-bg px-2 py-0.5 text-xs font-medium text-text-secondary">
                Plantilla de DocuFlow
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-4">
        {b.description && <p className="text-sm text-text-secondary">{b.description}</p>}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Etapas</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.stageCount}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Roles sugeridos</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.participantTemplateCount}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Requisitos de expediente</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.caseRequirementCount}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Requisitos de participante</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.participantRequirementCount}</div>
          </div>
        </div>
      </div>

      {isOwner && (
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <Link href={`/blueprints/${b.id}/edit`} className="rounded-input border border-border px-3 py-1.5 text-sm">
            Editar
          </Link>
          <Link href={`/blueprints/new?from=${b.id}`} className="rounded-input border border-border px-3 py-1.5 text-sm">
            Duplicar
          </Link>
          <button
            type="button"
            onClick={() => onDelete(b)}
            className="ml-auto flex items-center gap-1.5 rounded-input border border-error px-3 py-1.5 text-sm text-error"
          >
            <IconTrash className="size-4" /> Eliminar
          </button>
        </div>
      )}
    </div>
  );
}

export function BlueprintsDirectory({
  blueprints,
  isOwner,
  account,
}: {
  blueprints: BlueprintSummary[];
  isOwner: boolean;
  account: ShellAccount;
}) {
  const [pendingDelete, setPendingDelete] = useState<BlueprintSummary | null>(null);
  const [items, setItems] = useState(blueprints);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setError(null);
    setDeleting(true);
    const result = await deleteBlueprintAction(pendingDelete.id);
    setDeleting(false);
    if (!result.ok) {
      setError(result.message);
      setPendingDelete(null);
      return;
    }
    setItems((prev) => prev.filter((b) => b.id !== pendingDelete.id));
    setPendingDelete(null);
  }

  return (
    <AppShell active="blueprints" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Plantillas</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-text-primary">Plantillas</h2>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Una plantilla es un punto de partida, no un formato fijo. Al clonarla en un expediente
              se crea un expediente independiente que puedes editar libremente — cambiar una
              plantilla nunca afecta a los expedientes ya creados a partir de ella.
            </p>
          </div>
          {isOwner && (
            <Link
              href="/blueprints/new"
              className="flex shrink-0 items-center gap-1.5 rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white"
            >
              <IconPlus className="size-4" /> Nueva plantilla
            </Link>
          )}
        </div>

        {error && <p className="mb-4 text-sm text-error">{error}</p>}

        {items.length === 0 ? (
          <p className="text-sm text-text-secondary">Todavía no hay plantillas en esta organización.</p>
        ) : (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {items.map((b) => (
              <BlueprintCard key={b.id} b={b} isOwner={isOwner} onDelete={setPendingDelete} />
            ))}
          </div>
        )}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-error/10 text-error">
              <IconTrash className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Eliminar “{pendingDelete.name}”</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Esta acción es permanente. Los expedientes creados previamente no se verán afectados.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setPendingDelete(null)} className="rounded-input border border-border px-3.5 py-2 text-sm">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="rounded-input bg-error px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleting ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
