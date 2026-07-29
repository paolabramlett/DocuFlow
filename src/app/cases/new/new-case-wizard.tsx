"use client";

/*
 * DocuFlow — New Case flow.
 *
 * The Staff spine: start from a Blueprint, add Participants, assign each their Requirements, and
 * send invitations. A focused flow inside the workspace shell.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { createCaseAction, getBlueprintDefinitionAction } from "../actions";
import type { CreatedCase } from "@/application/create-case-with-participants";
import type { FailureReason } from "@/application/errors";
import type { BlueprintDefinition } from "@/features/blueprints/queries";
import type { BlueprintSummary } from "@/features/blueprints/queries";
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconDocument,
  IconMail,
  IconPlus,
  IconShield,
  IconTrash,
  IconX,
} from "@/components/icons";

interface ActionFailure {
  reason: FailureReason;
  message: string;
  issues?: readonly { path: string; message: string }[];
}

type Participant =
  | {
      id: string;
      source: "blueprint";
      participantTemplateRoleKey: string;
      role: string;
      name: string;
      email: string;
      selectedRequirementKeys: string[];
    }
  | {
      id: string;
      source: "manual";
      role: string;
      name: string;
      email: string;
      requirements: string[];
    };

const GENERIC_REQUIREMENT_POOL = ["INE", "CURP", "Comprobante de domicilio"];

const STEPS = ["Plantilla", "Participantes", "Requisitos", "Invitar"] as const;
type Step = 0 | 1 | 2 | 3;

let seq = 0;
const uid = () => `p${++seq}`;

export function NewCaseWizard({
  blueprints,
  account,
}: {
  blueprints: BlueprintSummary[];
  account: ShellAccount;
}) {
  const [step, setStep] = useState<Step>(0);
  const [blueprintId, setBlueprintId] = useState<string | null>(null);
  const [blueprintDefinition, setBlueprintDefinition] = useState<BlueprintDefinition | null>(null);
  const [blueprintChosen, setBlueprintChosen] = useState(false);
  const [title, setTitle] = useState("");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [pendingBlueprintChoice, setPendingBlueprintChoice] = useState<BlueprintSummary | null | undefined>(undefined);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [result, setResult] = useState<CreatedCase | null>(null);
  const router = useRouter();

  // availableRequirements is derived, not stored — one source of truth (blueprintDefinition), so
  // it can never go stale relative to a participant's own snapshot.
  const availableRequirementsByRole = useMemo(() => {
    const map = new Map<string, { key: string; label: string }[]>();
    if (!blueprintDefinition) return map;
    for (const t of blueprintDefinition.participantTemplates) {
      map.set(
        t.roleKey,
        blueprintDefinition.requirements
          .filter((r) => r.scope === "participant" && r.participantRoleKey === t.roleKey)
          .map((r) => ({ key: r.key, label: r.label })),
      );
    }
    return map;
  }, [blueprintDefinition]);

  const manualSuggestionPool = useMemo(() => {
    if (!blueprintDefinition) return GENERIC_REQUIREMENT_POOL;
    const labels = blueprintDefinition.requirements
      .filter((r) => r.scope === "participant")
      .map((r) => r.label);
    return labels.length > 0 ? Array.from(new Set(labels)) : GENERIC_REQUIREMENT_POOL;
  }, [blueprintDefinition]);

  async function applyBlueprint(summary: BlueprintSummary | null) {
    if (summary === null) {
      setBlueprintId(null);
      setBlueprintDefinition(null);
      setBlueprintChosen(true);
      setTitle("");
      setParticipants([]);
      setIsDirty(false); // clearing the wizard is itself an "applied" state, not a dirty one
      return;
    }
    setPending(true);
    const response = await getBlueprintDefinitionAction(summary.id);
    setPending(false);
    if (!response.ok) {
      setFailure({ reason: response.reason, message: response.message, issues: response.issues });
      return;
    }
    const def = response.data;
    setBlueprintId(def.id);
    setBlueprintDefinition(def);
    setBlueprintChosen(true);
    setTitle(def.name); // no trailing separator — the cursor position after "Compraventa ·" was awkward
    setParticipants(
      [...def.participantTemplates]
        .sort((a, b) => a.position - b.position)
        .map((t) => ({
          id: uid(),
          source: "blueprint" as const,
          participantTemplateRoleKey: t.roleKey,
          role: t.displayName,
          name: "",
          email: "",
          selectedRequirementKeys: (availableRequirementsSnapshot(def, t.roleKey)).map((r) => r.key),
        })),
    );
    setIsDirty(false); // prefill itself is never "dirty"
  }

  // A one-off helper used only during applyBlueprint's own construction of the initial selection —
  // the *ongoing* source of truth participants are rendered against is always
  // availableRequirementsByRole (the memo above), never this snapshot.
  function availableRequirementsSnapshot(def: BlueprintDefinition, roleKey: string) {
    return def.requirements
      .filter((r) => r.scope === "participant" && r.participantRoleKey === roleKey)
      .map((r) => ({ key: r.key, label: r.label }));
  }

  function chooseBlueprint(summary: BlueprintSummary | null) {
    if (isDirty) {
      setPendingBlueprintChoice(summary);
      return;
    }
    void applyBlueprint(summary);
  }

  function confirmBlueprintSwitch() {
    const choice = pendingBlueprintChoice;
    setPendingBlueprintChoice(undefined);
    void applyBlueprint(choice ?? null);
  }

  function cancelBlueprintSwitch() {
    setPendingBlueprintChoice(undefined);
  }

  function markDirty() {
    if (!isDirty) setIsDirty(true);
  }

  async function submit() {
    setPending(true);
    setFailure(null);

    const response = await createCaseAction({
      title,
      blueprintId: blueprintId ?? undefined,
      participants: participants.map((p) =>
        p.source === "blueprint"
          ? {
              source: "blueprint" as const,
              participantTemplateRoleKey: p.participantTemplateRoleKey,
              roleLabel: p.role,
              fullName: p.name,
              email: p.email,
              requirementKeys: p.selectedRequirementKeys,
            }
          : {
              source: "manual" as const,
              roleLabel: p.role,
              fullName: p.name,
              email: p.email,
              requirements: p.requirements,
            },
      ),
      sendInvitations: true,
    });

    setPending(false);

    if (!response.ok) {
      setFailure({ reason: response.reason, message: response.message, issues: response.issues });
      return;
    }

    setResult(response.data);
    setSent(true);
    router.refresh();
  }

  function updateParticipant(id: string, patch: Partial<Participant>) {
    markDirty();
    setParticipants(participants.map((p) => (p.id === id ? { ...p, ...patch } as Participant : p)));
  }

  function removeParticipant(id: string) {
    markDirty();
    setParticipants(participants.filter((p) => p.id !== id));
  }

  function addManualParticipant() {
    markDirty();
    setParticipants([
      ...participants,
      { id: uid(), source: "manual", role: "", name: "", email: "", requirements: [] },
    ]);
  }

  function toggleRequirement(participantId: string) {
    return (key: string, label: string) => {
      markDirty();
      setParticipants(
        participants.map((p) => {
          if (p.id !== participantId) return p;
          if (p.source === "blueprint") {
            const has = p.selectedRequirementKeys.includes(key);
            return {
              ...p,
              selectedRequirementKeys: has
                ? p.selectedRequirementKeys.filter((k) => k !== key)
                : [...p.selectedRequirementKeys, key],
            };
          }
          const has = p.requirements.includes(label);
          return {
            ...p,
            requirements: has ? p.requirements.filter((r) => r !== label) : [...p.requirements, label],
          };
        }),
      );
    };
  }

  function setTitleDirty(value: string) {
    markDirty();
    setTitle(value);
  }

  const canContinue =
    (step === 0 && blueprintChosen) ||
    (step === 1 && participants.length > 0 && participants.every((p) => p.name && p.email)) ||
    step === 2 ||
    step === 3;

  return (
    <AppShell active="cases" account={account}>
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

      <div className="flex-1 overflow-y-auto px-7 py-8">
        <div className="mx-auto max-w-4xl">
          {sent && result ? (
            <SentState result={result} />
          ) : (
            <>
              {failure && <FailureBanner failure={failure} onDismiss={() => setFailure(null)} />}
              {step === 0 && (
                <StepBlueprint
                  blueprints={blueprints}
                  selectedId={blueprintId}
                  blueprintChosen={blueprintChosen}
                  onChoose={chooseBlueprint}
                />
              )}
              {step === 1 && (
                <StepParticipants
                  title={title}
                  setTitle={setTitleDirty}
                  participants={participants}
                  onUpdate={updateParticipant}
                  onRemove={removeParticipant}
                  onAddManual={addManualParticipant}
                />
              )}
              {step === 2 && (
                <StepRequirements
                  participants={participants}
                  availableRequirementsByRole={availableRequirementsByRole}
                  manualSuggestionPool={manualSuggestionPool}
                  onToggle={toggleRequirement}
                />
              )}
              {step === 3 && <StepReview title={title} participants={participants} />}
            </>
          )}
        </div>
      </div>

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
                onClick={submit}
                disabled={pending}
                className="flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <IconMail className="size-4" /> {pending ? "Creando expediente…" : "Enviar invitaciones"}
              </button>
            )}
          </div>
        </div>
      )}

      {pendingBlueprintChoice !== undefined && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-royal-50 text-royal-600">
              <IconShield className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Cambiar de plantilla</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Ya hiciste cambios en los participantes o requisitos. Cambiar de plantilla reemplaza
              todo lo capturado hasta ahora.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelBlueprintSwitch}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmBlueprintSwitch}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700"
              >
                Reemplazar
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ---------- Step 1: Blueprint ----------
function StepBlueprint({
  blueprints,
  selectedId,
  blueprintChosen,
  onChoose,
}: {
  blueprints: BlueprintSummary[];
  selectedId: string | null;
  blueprintChosen: boolean;
  onChoose: (b: BlueprintSummary | null) => void;
}) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Comienza desde una plantilla</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Una plantilla arma los participantes y requisitos por ti. El expediente queda totalmente editable después.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {blueprints.map((b) => {
          const active = selectedId === b.id;
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
              {b.description && <p className="mt-1 text-sm text-text-secondary">{b.description}</p>}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary tabular">
                <span>{b.participantTemplateCount} rol{b.participantTemplateCount === 1 ? "" : "es"}</span>
                <span>{b.stageCount} etapa{b.stageCount === 1 ? "" : "s"}</span>
                <span>{b.caseRequirementCount} req. de expediente</span>
                <span>{b.participantRequirementCount} req. de participante</span>
              </div>
            </button>
          );
        })}
        <button
          key="blank"
          onClick={() => onChoose(null)}
          className={`rounded-card border bg-surface p-5 text-left transition-all ${
            blueprintChosen && selectedId === null ? "border-royal-600 shadow-md ring-1 ring-royal-600" : "border-border hover:border-royal-100 hover:shadow-sm"
          }`}
        >
          <div className="flex size-10 items-center justify-center rounded-input bg-royal-50 text-royal-600">
            <IconDocument className="size-5" />
          </div>
          <div className="mt-4 text-base font-semibold text-text-primary">Expediente en blanco</div>
          <p className="mt-1 text-sm text-text-secondary">Empieza de cero y arma el expediente tú mismo.</p>
        </button>
      </div>
    </div>
  );
}

// ---------- Step 2: Participants ----------
function StepParticipants({
  title,
  setTitle,
  participants,
  onUpdate,
  onRemove,
  onAddManual,
}: {
  title: string;
  setTitle: (v: string) => void;
  participants: Participant[];
  onUpdate: (id: string, patch: Partial<Participant>) => void;
  onRemove: (id: string) => void;
  onAddManual: () => void;
}) {
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
                <button onClick={() => onRemove(p.id)} className="text-text-secondary transition-colors hover:text-error">
                  <IconTrash className="size-4" />
                </button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                value={p.role}
                onChange={(e) => onUpdate(p.id, { role: e.target.value })}
                placeholder="Rol (ej. Comprador)"
                readOnly={p.source === "blueprint"}
                className="rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100 read-only:bg-app-bg"
              />
              <input
                value={p.name}
                onChange={(e) => onUpdate(p.id, { name: e.target.value })}
                placeholder="Nombre completo"
                className="rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
              />
              <input
                value={p.email}
                onChange={(e) => onUpdate(p.id, { email: e.target.value })}
                placeholder="Correo electrónico"
                type="email"
                className="rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
              />
            </div>
          </div>
        ))}
      </div>

      <button onClick={onAddManual} className="mt-3 flex items-center gap-2 rounded-input border border-dashed border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-royal-100 hover:text-royal-600">
        <IconPlus className="size-4" /> Agregar participante
      </button>
    </div>
  );
}

// ---------- Step 3: Requirements ----------
function StepRequirements({
  participants,
  availableRequirementsByRole,
  manualSuggestionPool,
  onToggle,
}: {
  participants: Participant[];
  availableRequirementsByRole: Map<string, { key: string; label: string }[]>;
  manualSuggestionPool: string[];
  onToggle: (participantId: string) => (key: string, label: string) => void;
}) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Asigna los requisitos</h1>
      <p className="mt-1 text-sm text-text-secondary">Elige qué debe entregar cada participante. Solo ven su propia lista.</p>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {participants.map((p) => {
          const pool: { key: string; label: string }[] =
            p.source === "blueprint"
              ? availableRequirementsByRole.get(p.participantTemplateRoleKey) ?? []
              : manualSuggestionPool.map((label) => ({ key: label, label }));
          const selectedCount = p.source === "blueprint" ? p.selectedRequirementKeys.length : p.requirements.length;

          return (
            <div key={p.id} className="overflow-hidden rounded-card border border-border bg-surface">
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <div className="flex size-8 items-center justify-center rounded-full bg-royal-100 text-xs font-semibold text-royal-700">
                  {(p.name || p.role || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-semibold text-text-primary">{p.name || "Sin nombre"}</div>
                  <div className="text-xs text-text-secondary">{p.role || "Sin rol"} · {selectedCount} requisitos</div>
                </div>
              </div>
              <ul className="p-2">
                {pool.map(({ key, label }) => {
                  const on = p.source === "blueprint" ? p.selectedRequirementKeys.includes(key) : p.requirements.includes(label);
                  return (
                    <li key={key}>
                      <button
                        onClick={() => onToggle(p.id)(key, label)}
                        className="flex w-full items-center gap-3 rounded-input px-2.5 py-2 text-left transition-colors hover:bg-app-bg"
                      >
                        <span className={`flex size-5 items-center justify-center rounded-[6px] border transition-colors ${
                          on ? "border-royal-600 bg-royal-600 text-white" : "border-border bg-surface"
                        }`}>
                          {on && <IconCheck className="size-3.5" />}
                        </span>
                        <span className={`text-sm ${on ? "text-text-primary" : "text-text-secondary"}`}>{label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Step 4: Review ----------
function StepReview({ title, participants }: { title: string; participants: Participant[] }) {
  const totalReqs = participants.reduce(
    (n, p) => n + (p.source === "blueprint" ? p.selectedRequirementKeys.length : p.requirements.length),
    0,
  );
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Revisar e invitar</h1>
      <p className="mt-1 text-sm text-text-secondary">Confirma el expediente. Cada participante recibe un código de un solo uso para subir sus documentos — sin necesidad de crear cuenta.</p>

      <div className="mt-6 rounded-card border border-border bg-surface p-5">
        <div className="flex items-center justify-between">
          <div>
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
              {p.source === "blueprint" ? p.selectedRequirementKeys.length : p.requirements.length} por entregar
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Dedicated failure states ----------
function FailureBanner({ failure, onDismiss }: { failure: ActionFailure; onDismiss: () => void }) {
  const COPY: Record<FailureReason, { title: string; hint: string }> = {
    unauthenticated: { title: "Tu sesión expiró", hint: "Inicia sesión de nuevo para continuar. No perdiste lo que capturaste." },
    forbidden: { title: "No tienes acceso", hint: "Tu cuenta no puede crear expedientes en esta organización." },
    validation: { title: "Revisa los datos", hint: "Corrige lo señalado y vuelve a intentar." },
    not_found: { title: "No encontramos algo", hint: "Puede que se haya eliminado mientras trabajabas. Recarga e intenta de nuevo." },
    conflict: { title: "Ya existe", hint: "Parece que este expediente ya fue creado." },
    delivery_failed: { title: "No pudimos enviar las invitaciones", hint: "El expediente se creó; puedes reenviarlas desde el expediente." },
    unexpected: { title: "Algo falló", hint: "Puede que el expediente ya se haya creado parcialmente. Revisa Expedientes antes de reintentar." },
  };
  const copy = COPY[failure.reason];

  return (
    <div className="mb-6 rounded-card border border-error/25 bg-error-bg/60 px-5 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-error text-white">
          <IconX className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-primary">{copy.title}</div>
          <p className="mt-0.5 text-sm text-text-secondary">{failure.message || copy.hint}</p>
          {failure.issues && failure.issues.length > 0 && (
            <ul className="mt-2 space-y-1">
              {failure.issues.map((issue, i) => (
                <li key={i} className="text-sm text-error">• {issue.message}</li>
              ))}
            </ul>
          )}
          {failure.reason === "unauthenticated" && (
            <Link href="/login" className="mt-3 inline-flex rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
              Iniciar sesión
            </Link>
          )}
        </div>
        <button onClick={onDismiss} className="shrink-0 rounded-input p-1 text-text-secondary transition-colors hover:bg-surface hover:text-text-primary">
          <IconX className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ---------- Sent ----------
function SentState({ result }: { result: CreatedCase }) {
  const invited = result.participants.filter((p) => p.invited);
  const failed = result.invitationFailures;

  return (
    <div className="mx-auto max-w-lg py-10 text-center">
      <div className="complete-check mx-auto flex size-16 items-center justify-center rounded-full bg-royal-600 text-white">
        <IconMail className="size-8" />
      </div>
      <div className="complete-rise">
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-text-primary">
          {failed.length === 0 ? "Invitaciones enviadas" : "Expediente creado"}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          {invited.length > 0 ? (
            <>
              {invited.length} participante{invited.length > 1 ? "s" : ""} {invited.length > 1 ? "recibirán" : "recibirá"} un
              código de un solo uso para subir sus documentos. El expediente avanza solo conforme cada uno se aprueba.
            </>
          ) : (
            <>El expediente se creó. Puedes enviar las invitaciones desde el expediente.</>
          )}
        </p>

        <div className="mt-6 space-y-2 text-left">
          {result.participants.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-input border border-border bg-surface px-4 py-2.5">
              {p.invited ? <IconCheck className="size-4 text-success" /> : <IconX className="size-4 text-warning" />}
              <span className="text-sm text-text-primary">{p.email}</span>
              <span className="ml-auto text-xs text-text-secondary">{p.role}</span>
            </div>
          ))}
        </div>

        {failed.length > 0 && (
          <p className="mt-3 text-left text-sm text-warning">
            No pudimos enviar {failed.length} invitación{failed.length > 1 ? "es" : ""}. Puedes reintentarlo desde el expediente.
          </p>
        )}

        <Link href="/cases" className="mt-6 inline-flex items-center gap-2 rounded-input bg-royal-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
          Ir al expediente
        </Link>
      </div>
    </div>
  );
}
