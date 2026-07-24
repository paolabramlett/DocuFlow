"use client";

/*
 * DocuFlow — Blueprint Library.
 *
 * Blueprints are starting points, not templates: cloning one into a Case produces an independent,
 * fully editable Case. This screen curates them. Content is synthetic.
 */

import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { IconCheck, IconDocument, IconPlus, IconSearch } from "@/components/icons";

type Blueprint = {
  id: string;
  name: string;
  industry: string;
  description: string;
  roles: string[];
  requirements: string[];
  usedIn: number;
};

const BLUEPRINTS: Blueprint[] = [
  {
    id: "bp-compraventa", name: "Compraventa", industry: "Notaría",
    description: "Venta de un inmueble entre un comprador y un vendedor.",
    roles: ["Comprador", "Vendedor"],
    requirements: ["INE", "CURP", "RFC", "Comprobante de domicilio", "Título de propiedad", "Constancia de situación fiscal"],
    usedIn: 34,
  },
  {
    id: "bp-testamento", name: "Testamento", industry: "Notaría",
    description: "Testamento otorgado por un solo testador.",
    roles: ["Testador"],
    requirements: ["INE", "Inventario de bienes", "Datos de testigos"],
    usedIn: 12,
  },
  {
    id: "bp-poder", name: "Poder notarial", industry: "Notaría",
    description: "Poder otorgado por una persona.",
    roles: ["Otorgante"],
    requirements: ["INE", "Datos del apoderado", "Autorización firmada"],
    usedIn: 21,
  },
  {
    id: "bp-sociedad", name: "Constitución de sociedad", industry: "Notaría",
    description: "Constitución con varios socios fundadores.",
    roles: ["Socio fundador", "Socio fundador"],
    requirements: ["INE", "CURP", "Aportación de capital", "Estatutos sociales"],
    usedIn: 8,
  },
];

function BlueprintCard({ b }: { b: Blueprint }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-input bg-royal-50 text-royal-600">
            <IconDocument className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold text-text-primary">{b.name}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-text-secondary">
              <span className="rounded-full bg-app-bg px-2 py-0.5 font-medium">{b.industry}</span>
              <span className="tabular">Usada en {b.usedIn} expedientes</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-4">
        <p className="text-sm text-text-secondary">{b.description}</p>

        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Participantes</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {b.roles.map((role, i) => (
              <span key={i} className="rounded-full bg-royal-50 px-2.5 py-1 text-xs font-medium text-royal-700">{role}</span>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            {b.requirements.length} requisitos
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
            {b.requirements.map((r) => (
              <li key={r} className="flex items-center gap-2 text-sm text-text-primary">
                <IconCheck className="size-3.5 shrink-0 text-royal-500" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-border px-5 py-3">
        <Link href="/cases/new" className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
          Usar plantilla
        </Link>
        <button className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg">Editar</button>
        <button className="ml-auto rounded-input px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-app-bg hover:text-text-primary">Duplicar</button>
      </div>
    </div>
  );
}

export default function BlueprintsPage() {
  return (
    <AppShell active="blueprints">
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <div className="relative w-full max-w-sm">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
          <input placeholder="Buscar plantillas…" className="w-full rounded-input border border-border bg-app-bg py-2 pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100" />
        </div>
        <button className="ml-auto flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
          <IconPlus className="size-4" /> Nueva plantilla
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Plantillas</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Una plantilla es un punto de partida, no un formato fijo. Al clonarla en un expediente se crea un expediente independiente que puedes editar libremente — cambiar una plantilla nunca afecta a los expedientes ya creados a partir de ella.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {BLUEPRINTS.map((b) => <BlueprintCard key={b.id} b={b} />)}
        </div>

        <p className="mt-6 text-center font-mono text-xs text-text-secondary/60">Datos de demostración sintéticos · DocuFlow lenguaje de diseño v3</p>
      </div>
    </AppShell>
  );
}
