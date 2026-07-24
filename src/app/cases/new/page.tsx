"use client";

/*
 * DocuFlow — New Case flow.
 *
 * The Staff spine: start from a Blueprint, add Participants, assign each their Requirements, and
 * send invitations. A focused flow inside the workspace shell. Blueprint content is synthetic.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconDocument,
  IconMail,
  IconPlus,
  IconTrash,
} from "@/components/icons";

type Blueprint = {
  id: string;
  name: string;
  industry: string;
  description: string;
  roles: string[];
  requirements: string[];
};

const BLUEPRINTS: Blueprint[] = [
  {
    id: "bp-compraventa",
    name: "Compraventa",
    industry: "Notaría",
    description: "Venta de un inmueble entre un comprador y un vendedor.",
    roles: ["Comprador", "Vendedor"],
    requirements: ["INE", "CURP", "RFC", "Comprobante de domicilio", "Título de propiedad", "Constancia de situación fiscal"],
  },
  {
    id: "bp-testamento",
    name: "Testamento",
    industry: "Notaría",
    description: "Testamento otorgado por un solo testador.",
    roles: ["Testador"],
    requirements: ["INE", "Inventario de bienes", "Datos de testigos"],
  },
  {
    id: "bp-poder",
    name: "Poder notarial",
    industry: "Notaría",
    description: "Poder otorgado por una persona.",
    roles: ["Otorgante"],
    requirements: ["INE", "Datos del apoderado", "Autorización firmada"],
  },
  {
    id: "bp-sociedad",
    name: "Constitución de sociedad",
    industry: "Notaría",
    description: "Constitución con varios socios fundadores.",
    roles: ["Socio fundador", "Socio fundador"],
    requirements: ["INE", "CURP", "Aportación de capital", "Estatutos sociales"],
  },
];

const BLANK: Blueprint = {
  id: "blank",
  name: "Expediente en blanco",
  industry: "—",
  description: "Empieza de cero y arma el expediente tú mismo.",
  roles: [],
  requirements: [],
};

type Participant = { id: string; role: string; name: string; email: string; requirements: string[] };

const STEPS = ["Plantilla", "Participantes", "Requisitos", "Invitar"] as const;
type Step = 0 | 1 | 2 | 3;

let seq = 0;
const uid = () => `p${++seq}`;

export default function NewCasePage() {
  const [step, setStep] = useState<Step>(0);
  const [blueprintId, setBlueprintId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [sent, setSent] = useState(false);

  const blueprint = useMemo(
    () => (blueprintId === "blank" ? BLANK : BLUEPRINTS.find((b) => b.id === blueprintId) ?? null),
    [blueprintId],
  );

  function chooseBlueprint(b: Blueprint) {
    setBlueprintId(b.id);
    setTitle(b.id === "blank" ? "" : `${b.name} · `);
    setParticipants(
      b.roles.map((role) => ({ id: uid(), role, name: "", email: "", requirements: [...b.requirements] })),
    );
  }

  const canContinue =
    (step === 0 && blueprint !== null) ||
    (step === 1 && participants.length > 0 && participants.every((p) => p.name && p.email)) ||
    step === 2 ||
    step === 3;

  return (
    <AppShell active="cases">
      {/* Header + steps */}
      <div className="border-b border-border bg-surface px-7 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Link href="/cases" className="flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary">
            <IconArrowLeft className="size-4" /> Expedientes
          </Link>
          <div className="flex items-center gap-2">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <div className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                  i === step ? "bg-royal-50 text-royal-700" : i < step ? "text-royal-600" : "text-text-secondary"
                }`}>
                  <span className={`flex size-5 items-center justify-center rounded-full text-xs ${
                    i < step ? "bg-royal-600 text-white" : i === step ? "bg-royal-600 text-white" : "bg-app-bg text-text-secondary"
                  }`}>
                    {i < step ? <IconCheck className="size-3" /> : i + 1}
                  </span>
                  <span className="hidden sm:inline">{label}</span>
                </div>
                {i < STEPS.length - 1 && <span className="h-px w-4 bg-border" />}
              </div>
            ))}
          </div>
          <div className="w-16" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-7 py-8">
        <div className="mx-auto max-w-4xl">
          {sent ? (
            <SentState participants={participants} />
          ) : (
            <>
              {step === 0 && <StepBlueprint selected={blueprintId} onChoose={chooseBlueprint} />}
              {step === 1 && blueprint && (
                <StepParticipants
                  title={title}
                  setTitle={setTitle}
                  blueprint={blueprint}
                  participants={participants}
                  setParticipants={setParticipants}
                />
              )}
              {step === 2 && <StepRequirements blueprint={blueprint!} participants={participants} setParticipants={setParticipants} />}
              {step === 3 && <StepReview title={title} blueprint={blueprint!} participants={participants} />}
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      {!sent && (
        <div className="border-t border-border bg-surface px-7 py-4">
          <div className="mx-auto flex max-w-4xl items-center justify-between">
            <button
              onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}
              disabled={step === 0}
              className="rounded-input border border-border bg-surface px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              Atrás
            </button>
            {step < 3 ? (
              <button
                onClick={() => canContinue && setStep((s) => (s + 1) as Step)}
                disabled={!canContinue}
                className="flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continuar <IconArrowRight className="size-4" />
              </button>
            ) : (
              <button
                onClick={() => setSent(true)}
                className="flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700"
              >
                <IconMail className="size-4" /> Enviar invitaciones
              </button>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ---------- Step 1: Blueprint ----------
function StepBlueprint({ selected, onChoose }: { selected: string | null; onChoose: (b: Blueprint) => void }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Comienza desde una plantilla</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Una plantilla arma los participantes y requisitos por ti. El expediente queda totalmente editable después.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {[...BLUEPRINTS, BLANK].map((b) => {
          const active = selected === b.id;
          return (
            <button
              key={b.id}
              onClick={() => onChoose(b)}
              className={`rounded-card border bg-surface p-5 text-left transition-all ${
                active ? "border-royal-600 shadow-md ring-1 ring-royal-600" : "border-border hover:border-royal-100 hover:shadow-sm"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex size-10 items-center justify-center rounded-input bg-royal-50 text-royal-600">
                  <IconDocument className="size-5" />
                </div>
                {active && (
                  <span className="flex size-5 items-center justify-center rounded-full bg-royal-600 text-white">
                    <IconCheck className="size-3" />
                  </span>
                )}
              </div>
              <div className="mt-4 text-base font-semibold text-text-primary">{b.name}</div>
              <p className="mt-1 text-sm text-text-secondary">{b.description}</p>
              {b.id !== "blank" && (
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary tabular">
                  <span>{b.roles.length} participante{b.roles.length > 1 ? "s" : ""}</span>
                  <span>{b.requirements.length} requisitos</span>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Step 2: Participants ----------
function StepParticipants({
  title,
  setTitle,
  blueprint,
  participants,
  setParticipants,
}: {
  title: string;
  setTitle: (v: string) => void;
  blueprint: Blueprint;
  participants: Participant[];
  setParticipants: (p: Participant[]) => void;
}) {
  const update = (id: string, patch: Partial<Participant>) =>
    setParticipants(participants.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => setParticipants(participants.filter((p) => p.id !== id));
  const add = () =>
    setParticipants([...participants, { id: uid(), role: "", name: "", email: "", requirements: [...blueprint.requirements] }]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Expediente y participantes</h1>
      <p className="mt-1 text-sm text-text-secondary">¿Quiénes participan en este expediente? Cada participante tiene su propia lista privada.</p>

      <label className="mt-6 block">
        <span className="mb-1.5 block text-sm font-medium text-text-primary">Título del expediente</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="ej. Compraventa · Restrepo"
          className="w-full max-w-md rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
        />
      </label>

      <div className="mt-6 space-y-3">
        {participants.map((p, i) => (
          <div key={p.id} className="rounded-card border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Participante {i + 1}</span>
              {participants.length > 1 && (
                <button onClick={() => remove(p.id)} className="text-text-secondary transition-colors hover:text-error">
                  <IconTrash className="size-4" />
                </button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                value={p.role}
                onChange={(e) => update(p.id, { role: e.target.value })}
                placeholder="Rol (ej. Comprador)"
                className="rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
              />
              <input
                value={p.name}
                onChange={(e) => update(p.id, { name: e.target.value })}
                placeholder="Nombre completo"
                className="rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
              />
              <input
                value={p.email}
                onChange={(e) => update(p.id, { email: e.target.value })}
                placeholder="Correo electrónico"
                type="email"
                className="rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
              />
            </div>
          </div>
        ))}
      </div>

      <button onClick={add} className="mt-3 flex items-center gap-2 rounded-input border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-royal-100 hover:text-royal-600">
        <IconPlus className="size-4" /> Agregar participante
      </button>
    </div>
  );
}

// ---------- Step 3: Requirements ----------
function StepRequirements({
  blueprint,
  participants,
  setParticipants,
}: {
  blueprint: Blueprint;
  participants: Participant[];
  setParticipants: (p: Participant[]) => void;
}) {
  const pool = blueprint.requirements.length > 0 ? blueprint.requirements : ["INE", "CURP", "Comprobante de domicilio"];
  const toggle = (pid: string, req: string) =>
    setParticipants(
      participants.map((p) =>
        p.id === pid
          ? { ...p, requirements: p.requirements.includes(req) ? p.requirements.filter((r) => r !== req) : [...p.requirements, req] }
          : p,
      ),
    );

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Asigna los requisitos</h1>
      <p className="mt-1 text-sm text-text-secondary">Elige qué debe entregar cada participante. Solo ven su propia lista.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {participants.map((p) => (
          <div key={p.id} className="overflow-hidden rounded-card border border-border bg-surface">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <div className="flex size-8 items-center justify-center rounded-full bg-royal-100 text-xs font-semibold text-royal-700">
                {(p.name || p.role || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-semibold text-text-primary">{p.name || "Sin nombre"}</div>
                <div className="text-xs text-text-secondary">{p.role || "Sin rol"} · {p.requirements.length} requisitos</div>
              </div>
            </div>
            <ul className="p-2">
              {pool.map((req) => {
                const on = p.requirements.includes(req);
                return (
                  <li key={req}>
                    <button
                      onClick={() => toggle(p.id, req)}
                      className="flex w-full items-center gap-3 rounded-input px-2.5 py-2 text-left transition-colors hover:bg-app-bg"
                    >
                      <span className={`flex size-5 items-center justify-center rounded-[6px] border transition-colors ${
                        on ? "border-royal-600 bg-royal-600 text-white" : "border-border bg-surface"
                      }`}>
                        {on && <IconCheck className="size-3.5" />}
                      </span>
                      <span className={`text-sm ${on ? "text-text-primary" : "text-text-secondary"}`}>{req}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Step 4: Review ----------
function StepReview({ title, blueprint, participants }: { title: string; blueprint: Blueprint; participants: Participant[] }) {
  const totalReqs = participants.reduce((n, p) => n + p.requirements.length, 0);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Revisar e invitar</h1>
      <p className="mt-1 text-sm text-text-secondary">Confirma el expediente. Cada participante recibe un código de un solo uso para subir sus documentos — sin necesidad de crear cuenta.</p>

      <div className="mt-6 rounded-card border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-text-secondary">Desde “{blueprint.name}”</div>
            <div className="mt-0.5 text-lg font-semibold text-text-primary">{title || "Expediente sin título"}</div>
          </div>
          <div className="flex gap-5 text-sm text-text-secondary tabular">
            <span>{participants.length} participantes</span>
            <span>{totalReqs} requisitos</span>
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {participants.map((p) => (
          <div key={p.id} className="flex items-center gap-4 rounded-card border border-border bg-surface px-4 py-3.5">
            <div className="flex size-9 items-center justify-center rounded-full bg-royal-100 text-xs font-semibold text-royal-700">
              {(p.name || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1">
              <div className="text-sm font-semibold text-text-primary">{p.name} <span className="font-normal text-text-secondary">· {p.role}</span></div>
              <div className="text-xs text-text-secondary">{p.email}</div>
            </div>
            <div className="flex items-center gap-2 text-sm text-text-secondary tabular">
              <IconMail className="size-4 text-royal-500" />
              {p.requirements.length} por entregar
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Sent ----------
function SentState({ participants }: { participants: Participant[] }) {
  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <div className="complete-check mx-auto flex size-16 items-center justify-center rounded-full bg-royal-600 text-white">
        <IconMail className="size-8" />
      </div>
      <div className="complete-rise">
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-text-primary">Invitaciones enviadas</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          {participants.length} participante{participants.length > 1 ? "s" : ""} {participants.length > 1 ? "recibirán" : "recibirá"} un código de un solo uso para subir sus documentos. El expediente avanza solo conforme cada uno se aprueba.
        </p>
        <div className="mt-6 space-y-2 text-left">
          {participants.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-input border border-border bg-surface px-4 py-2.5">
              <IconCheck className="size-4 text-success" />
              <span className="text-sm text-text-primary">{p.email}</span>
              <span className="ml-auto text-xs text-text-secondary">{p.role}</span>
            </div>
          ))}
        </div>
        <Link href="/cases" className="mt-6 inline-flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
          Ir al expediente
        </Link>
      </div>
    </div>
  );
}
