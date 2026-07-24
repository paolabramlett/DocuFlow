"use client";

/*
 * DocuFlow — Cases workspace.
 *
 * A place to WORK a case, not a dashboard. Identity comes from: a solid royal sidebar, a
 * progress-first case view, and Participants rendered as columns of progress — the signature of
 * the product (see DESIGN.md). All case data below is synthetic demonstration content.
 */

import Link from "next/link";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  IconCheck,
  IconClock,
  IconDot,
  IconEye,
  IconPlus,
  IconSearch,
  IconX,
  type IconProps,
} from "@/components/icons";

// ---------- Requirement state ----------
type ReqState = "approved" | "review" | "awaiting" | "rejected" | "missing";
const REQ: Record<ReqState, { label: string; fg: string; bg: string; bar: string; Icon: (p: IconProps) => React.ReactElement }> = {
  approved: { label: "Aprobado", fg: "text-success", bg: "bg-success-bg", bar: "bg-success", Icon: IconCheck },
  review: { label: "En revisión", fg: "text-review", bg: "bg-review-bg", bar: "bg-review", Icon: IconEye },
  awaiting: { label: "Pendiente", fg: "text-warning", bg: "bg-warning-bg", bar: "bg-warning", Icon: IconClock },
  rejected: { label: "Rechazado", fg: "text-error", bg: "bg-error-bg", bar: "bg-error", Icon: IconX },
  missing: { label: "Sin iniciar", fg: "text-neutral", bg: "bg-neutral-bg", bar: "bg-neutral", Icon: IconDot },
};

// ---------- Synthetic data ----------
type Requirement = { id: string; label: string; state: ReqState };
type Participant = { id: string; name: string; role: string; requirements: Requirement[] };
type CaseT = { id: string; ref: string; title: string; opened: string; participants: Participant[]; activity: { text: string; when: string }[] };

const CASES: CaseT[] = [
  {
    id: "c1", ref: "CASE-2026-0148", title: "Compraventa · Restrepo", opened: "12 jul 2026",
    participants: [
      { id: "p1", name: "Paola Restrepo", role: "Comprador", requirements: [
        { id: "R-01", label: "INE", state: "approved" },
        { id: "R-02", label: "CURP", state: "approved" },
        { id: "R-03", label: "RFC", state: "approved" },
        { id: "R-04", label: "Comprobante de domicilio", state: "review" },
      ]},
      { id: "p2", name: "Mateo Restrepo", role: "Vendedor", requirements: [
        { id: "R-05", label: "INE", state: "approved" },
        { id: "R-06", label: "CURP", state: "approved" },
        { id: "R-07", label: "Constancia de situación fiscal", state: "rejected" },
        { id: "R-08", label: "Título de propiedad", state: "missing" },
      ]},
    ],
    activity: [
      { text: "Paola Restrepo subió Comprobante de domicilio", when: "hace 2 h" },
      { text: "Rechazaste Constancia de situación fiscal — escaneo ilegible", when: "hace 3 h" },
      { text: "Recordatorio enviado a Mateo Restrepo", when: "Ayer" },
      { text: "Expediente creado desde la plantilla “Compraventa estándar”", when: "12 jul" },
    ],
  },
  {
    id: "c2", ref: "CASE-2026-0151", title: "Testamento · Villa", opened: "14 jul 2026",
    participants: [
      { id: "p3", name: "Ana Villa", role: "Testador", requirements: [
        { id: "R-09", label: "INE", state: "approved" },
        { id: "R-10", label: "Inventario de bienes", state: "review" },
        { id: "R-11", label: "Datos de testigos", state: "awaiting" },
      ]},
    ],
    activity: [{ text: "Ana Villa subió Inventario de bienes", when: "hace 5 h" }],
  },
  {
    id: "c3", ref: "CASE-2026-0139", title: "Poder notarial · Guzmán", opened: "8 jul 2026",
    participants: [
      { id: "p4", name: "Luis Guzmán", role: "Otorgante", requirements: [
        { id: "R-12", label: "INE", state: "approved" },
        { id: "R-13", label: "Datos del apoderado", state: "approved" },
        { id: "R-14", label: "Autorización firmada", state: "approved" },
      ]},
    ],
    activity: [{ text: "Aprobaste Autorización firmada", when: "hace 1 h" }],
  },
];

const flat = (c: CaseT) => c.participants.flatMap((p) => p.requirements);
const counts = (reqs: Requirement[]) => ({
  approved: reqs.filter((r) => r.state === "approved").length,
  review: reqs.filter((r) => r.state === "review").length,
  awaiting: reqs.filter((r) => r.state === "awaiting").length,
  rejected: reqs.filter((r) => r.state === "rejected").length,
  missing: reqs.filter((r) => r.state === "missing").length,
  total: reqs.length,
});
const pctApproved = (reqs: Requirement[]) => Math.round((counts(reqs).approved / reqs.length) * 100);

// ---------- Sidebar (solid Royal Blue 700) ----------
// ---------- Operative summary (answers "what do I do next") ----------
function OperativeStrip() {
  const items = [
    { label: "Esperando al cliente", value: 14, tint: "bg-warning" },
    { label: "Por revisar", value: 6, tint: "bg-review" },
    { label: "Listos para continuar", value: 11, tint: "bg-success" },
    { label: "Completados hoy", value: 3, tint: "bg-neutral" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {items.map((it) => (
        <button key={it.label} className="flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-royal-100 hover:bg-royal-50/40">
          <span className={`size-2.5 shrink-0 rounded-full ${it.tint}`} />
          <div>
            <div className="text-lg font-semibold tabular text-text-primary">{it.value}</div>
            <div className="text-xs text-text-secondary">{it.label}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------- Master list ----------
function CaseRow({ c, selected, onSelect }: { c: CaseT; selected: boolean; onSelect: () => void }) {
  const reqs = flat(c);
  const { approved, total } = counts(reqs);
  const pct = pctApproved(reqs);
  const done = approved === total;
  return (
    <button onClick={onSelect} className={`relative w-full border-b border-border px-4 py-4 text-left transition-colors ${selected ? "bg-royal-50" : "hover:bg-app-bg"}`}>
      {selected && <span className="absolute left-0 top-0 h-full w-[3px] bg-royal-600" />}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-text-secondary tabular">{c.ref}</span>
        {done ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><IconCheck className="size-3.5" />Completo</span>
        ) : (
          <span className="text-xs font-medium text-text-secondary tabular">{approved}/{total}</span>
        )}
      </div>
      <div className="mt-1 text-sm font-semibold text-text-primary">{c.title}</div>
      {/* Progress is always royal — advancement, not approval. Completion is told by the badge. */}
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-app-bg">
        <div className="h-full rounded-full bg-royal-500 transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
      </div>
    </button>
  );
}

// ---------- The signature: participant as a column of progress ----------
function ParticipantColumn({ p }: { p: Participant }) {
  const c = counts(p.requirements);
  const pct = pctApproved(p.requirements);
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-royal-100 text-xs font-semibold text-royal-700">
            {p.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold text-text-primary">{p.name}</div>
            <div className="text-xs text-text-secondary">{p.role}</div>
          </div>
          <div className="text-right">
            {pct === 100 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-1 text-xs font-semibold text-success">
                <IconCheck className="size-3.5" /> Completo
              </span>
            ) : (
              <div className="text-lg font-semibold tabular text-text-primary">{pct}%</div>
            )}
          </div>
        </div>
        {/* Progress bar stays royal even at 100% — completion is told by the check + badge. */}
        <div className="mt-3 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-app-bg">
            <div className="h-full rounded-full bg-royal-500 transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
          </div>
          {pct === 100 && (
            <span className="flex size-4 items-center justify-center rounded-full bg-success text-white">
              <IconCheck className="size-3" />
            </span>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary tabular">
          <span>{c.approved} aprobados</span>
          {c.review > 0 && <span>{c.review} en revisión</span>}
          {c.rejected > 0 && <span className="text-error">{c.rejected} rechazados</span>}
          {c.missing + c.awaiting > 0 && <span>{c.missing + c.awaiting} pendientes</span>}
        </div>
      </div>
      <ul className="flex-1">
        {p.requirements.map((r) => {
          const m = REQ[r.state];
          return (
            <li key={r.id} className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-b-0">
              <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${m.bg} ${m.fg}`}>
                <m.Icon className="size-3.5" />
              </span>
              <span className="flex-1 text-sm text-text-primary">{r.label}</span>
              <span className={`text-xs font-medium ${m.fg}`}>{m.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- Completion moment ----------
function CompletionState({ c }: { c: CaseT }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
      <div className="complete-check flex size-16 items-center justify-center rounded-full bg-success text-white">
        <IconCheck className="size-8" />
      </div>
      <div className="complete-rise mt-6">
        <div className="font-mono text-xs text-text-secondary tabular">{c.ref}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">Expediente completado</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          Todos los documentos requeridos fueron aprobados. Este expediente está listo para el siguiente paso.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <button className="rounded-input border border-border bg-surface px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg">
            Ver documentos
          </button>
          <button className="rounded-input bg-royal-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
            Continuar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Detail ----------
function CaseDetail({ c }: { c: CaseT }) {
  const reqs = flat(c);
  const k = counts(reqs);
  const pct = pctApproved(reqs);
  if (k.approved === k.total) return <CompletionState c={c} />;

  const segments: ReqState[] = reqs.map((r) => r.state);
  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-border px-7 py-5">
        <div>
          <div className="font-mono text-xs text-text-secondary tabular">{c.ref}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-text-primary">{c.title}</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {c.participants.length} participante{c.participants.length > 1 ? "s" : ""} · abierto el {c.opened}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg">Recordar</button>
          <button className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">Revisar documentos</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        {/* Progress hero */}
        <section>
          <div className="flex items-end justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Progreso del expediente</span>
            <span className="text-3xl font-semibold tabular text-text-primary">{pct}%</span>
          </div>
          <div className="mt-3 flex gap-1">
            {segments.map((state, i) => (
              <div key={i} className={`h-2.5 flex-1 rounded-full ${REQ[state].bar}`} title={REQ[state].label} style={{ opacity: state === "missing" ? 0.35 : 1 }} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-text-secondary tabular">
            <span className="text-success">{k.approved} aprobados</span>
            {k.review > 0 && <span className="text-review">{k.review} en revisión</span>}
            {k.rejected > 0 && <span className="text-error">{k.rejected} rechazados</span>}
            {k.awaiting > 0 && <span className="text-warning">{k.awaiting} pendientes</span>}
            {k.missing > 0 && <span>{k.missing} sin iniciar</span>}
          </div>
        </section>

        {/* Participants as columns of progress — the signature */}
        <section className="mt-8">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Participantes</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {c.participants.map((p) => <ParticipantColumn key={p.id} p={p} />)}
          </div>
        </section>

        {/* Activity — secondary, below */}
        <section className="mt-8">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Actividad</h3>
          <ol className="relative space-y-4 border-l border-border pl-5">
            {c.activity.map((a, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[23px] top-1.5 size-2 rounded-full bg-royal-500 ring-4 ring-surface" />
                <div className="text-sm text-text-primary">{a.text}</div>
                <div className="mt-0.5 text-xs text-text-secondary tabular">{a.when}</div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

// ---------- Page ----------
export default function CasesWorkspace() {
  const [selectedId, setSelectedId] = useState(CASES[0]!.id);
  const selected = CASES.find((c) => c.id === selectedId)!;

  return (
    <AppShell active="cases">
        {/* Clean top bar */}
        <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
          <div className="relative w-full max-w-sm">
            <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
            <input placeholder="Buscar expedientes, clientes, referencia…" className="w-full rounded-input border border-border bg-app-bg py-2 pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100" />
          </div>
          <Link href="/cases/new" className="ml-auto flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
            <IconPlus className="size-4" /> Nuevo expediente
          </Link>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 px-7 py-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">Tus expedientes</h1>
            <p className="mt-1 text-sm text-text-secondary">Retoma donde un expediente te está esperando.</p>
          </div>

          <OperativeStrip />

          {/* Master-detail */}
          <div className="flex min-h-0 flex-1 gap-6">
            <div className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-sm">
              <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
                <span className="text-sm font-semibold text-text-primary">Todos los expedientes</span>
                <span className="rounded-full bg-app-bg px-2 py-0.5 text-xs font-medium text-text-secondary tabular">{CASES.length}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {CASES.map((c) => <CaseRow key={c.id} c={c} selected={c.id === selectedId} onSelect={() => setSelectedId(c.id)} />)}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-hidden rounded-panel border border-border bg-surface shadow-md">
              <CaseDetail c={selected} />
            </div>
          </div>

          <p className="shrink-0 text-center font-mono text-xs text-text-secondary/60">Datos de demostración sintéticos · DocuFlow lenguaje de diseño v3</p>
        </div>
    </AppShell>
  );
}
