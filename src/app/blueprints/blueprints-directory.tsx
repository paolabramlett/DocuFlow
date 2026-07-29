"use client";

/*
 * DocuFlow — Blueprint Library. Real data. Cards show the four broken-out counts (stages,
 * participant roles, case-level requirements, participant-level requirements), not one total, so
 * the model's correctness is visible at a glance. No create/edit/detail UI in this pass.
 */

import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconDocument } from "@/components/icons";
import type { BlueprintSummary } from "@/features/blueprints/queries";

function BlueprintCard({ b }: { b: BlueprintSummary }) {
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
    </div>
  );
}

export function BlueprintsDirectory({
  blueprints,
  account,
}: {
  blueprints: BlueprintSummary[];
  account: ShellAccount;
}) {
  return (
    <AppShell active="blueprints" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Plantillas</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold tracking-tight text-text-primary">Plantillas</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Una plantilla es un punto de partida, no un formato fijo. Al clonarla en un expediente
            se crea un expediente independiente que puedes editar libremente — cambiar una
            plantilla nunca afecta a los expedientes ya creados a partir de ella.
          </p>
        </div>

        {blueprints.length === 0 ? (
          <p className="text-sm text-text-secondary">Todavía no hay plantillas en esta organización.</p>
        ) : (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {blueprints.map((b) => (
              <BlueprintCard key={b.id} b={b} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
