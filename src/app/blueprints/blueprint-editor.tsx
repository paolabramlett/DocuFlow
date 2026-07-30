"use client";

/*
 * DocuFlow — Blueprint authoring. One component, three modes (create/edit/duplicate) — see
 * docs/superpowers/specs/2026-07-29-blueprint-authoring-design.md, section 5.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconShield,
  IconTrash,
} from "@/components/icons";
import { saveBlueprintAction, deleteBlueprintAction } from "./actions";
import {
  BLUEPRINT_INTEGRITY_MESSAGES,
  BlueprintIntegrityError,
  validateBlueprintStructure,
  type BlueprintDefinition,
  type NormalizedBlueprint,
} from "@/features/blueprints/queries";
import type { SaveBlueprintInput } from "@/application/save-blueprint";

export type EditorMode = "create" | "edit" | "duplicate";

export interface DraftStage {
  draftId: string;
  name: string;
}
export interface DraftParticipantTemplate {
  draftId: string;
  roleKey: string;
  keyTouched: boolean;
  displayName: string;
}
export interface DraftRequirement {
  stageDraftId: string | null;
  participantRoleDraftId: string | null;
  key: string;
  keyTouched: boolean;
  type: string;
  label: string;
  instructions?: string;
  scope: "case" | "participant";
}
export interface EditorDraft {
  name: string;
  description: string;
  stages: DraftStage[];
  participantTemplates: DraftParticipantTemplate[];
  requirements: DraftRequirement[];
}

let seq = 0;
const uid = (prefix: string) => `${prefix}${++seq}`;

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Pure conversion from the editor's stable-draftId shape into the NormalizedBlueprint shape the
 * shared validator expects. Reordering stages/roles only changes array order, never the
 * stageDraftId/participantRoleDraftId a requirement carries — so this is the only place positions
 * and roleKeys are ever derived.
 */
export function serializeDraftToNormalizedBlueprint(draft: EditorDraft): NormalizedBlueprint {
  const stagePositionByDraftId = new Map(draft.stages.map((s, i) => [s.draftId, i]));
  const roleKeyByDraftId = new Map(draft.participantTemplates.map((t) => [t.draftId, t.roleKey]));

  return {
    name: draft.name,
    description: draft.description.trim().length > 0 ? draft.description : null,
    stages: draft.stages.map((s, i) => ({ name: s.name, position: i })),
    participantTemplates: draft.participantTemplates.map((t, i) => ({
      roleKey: t.roleKey,
      displayName: t.displayName,
      position: i,
    })),
    requirements: draft.requirements.map((r) => ({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions ?? null,
      scope: r.scope,
      participantRoleKey: r.scope === "participant" && r.participantRoleDraftId
        ? roleKeyByDraftId.get(r.participantRoleDraftId) ?? null
        : null,
      stagePosition: r.stageDraftId !== null ? stagePositionByDraftId.get(r.stageDraftId) ?? null : null,
    })),
  };
}

/** Converts the flat NormalizedBlueprint requirement shape into the discriminated-union shape
 *  saveBlueprintAction's Zod schema expects — the case branch must not carry a participantRoleKey
 *  key at all (`.strict()` rejects any key it doesn't declare, even with a null value), and
 *  optional fields must be omitted (undefined), never explicit null, since Zod's `.optional()`
 *  only accepts absence. */
function toSaveBlueprintPayload(
  normalized: NormalizedBlueprint,
  blueprintId: string | undefined,
): Omit<SaveBlueprintInput, "organizationId"> {
  return {
    blueprintId,
    name: normalized.name,
    description: normalized.description ?? undefined,
    stages: normalized.stages,
    participantTemplates: normalized.participantTemplates,
    requirements: normalized.requirements.map((r) =>
      r.scope === "case"
        ? {
            scope: "case" as const,
            key: r.key,
            type: r.type,
            label: r.label,
            instructions: r.instructions ?? undefined,
            stagePosition: r.stagePosition ?? undefined,
          }
        : {
            scope: "participant" as const,
            key: r.key,
            type: r.type,
            label: r.label,
            instructions: r.instructions ?? undefined,
            stagePosition: r.stagePosition ?? undefined,
            participantRoleKey: r.participantRoleKey!,
          },
    ),
  };
}

function draftFromBlueprint(bp: BlueprintDefinition | null): EditorDraft {
  if (!bp) {
    return { name: "", description: "", stages: [], participantTemplates: [], requirements: [] };
  }
  const stageDraftIdByPosition = new Map<number, string>();
  const roleDraftIdByRoleKey = new Map<string, string>();

  const stages: DraftStage[] = [...bp.stages].sort((a, b) => a.position - b.position).map((s) => {
    const draftId = uid("s");
    stageDraftIdByPosition.set(s.position, draftId);
    return { draftId, name: s.name };
  });
  const participantTemplates: DraftParticipantTemplate[] = [...bp.participantTemplates]
    .sort((a, b) => a.position - b.position)
    .map((t) => {
      const draftId = uid("p");
      roleDraftIdByRoleKey.set(t.roleKey, draftId);
      // keyTouched: true — renaming a loaded role's display name must never silently change its
      // roleKey.
      return { draftId, roleKey: t.roleKey, keyTouched: true, displayName: t.displayName };
    });
  const requirements: DraftRequirement[] = bp.requirements.map((r) => ({
    stageDraftId: r.stagePosition !== null ? stageDraftIdByPosition.get(r.stagePosition) ?? null : null,
    participantRoleDraftId: r.participantRoleKey !== null ? roleDraftIdByRoleKey.get(r.participantRoleKey) ?? null : null,
    key: r.key,
    keyTouched: true,
    type: r.type,
    label: r.label,
    instructions: r.instructions ?? undefined,
    scope: r.scope,
  }));

  return { name: bp.name, description: bp.description ?? "", stages, participantTemplates, requirements };
}

const STEP_LABELS = ["Información", "Etapas", "Participantes", "Requisitos", "Revisión"] as const;

const MODE_COPY: Record<EditorMode, { title: (name: string) => string; cta: string }> = {
  create: { title: () => "Nueva plantilla", cta: "Crear plantilla" },
  duplicate: { title: (name) => `Nueva plantilla (copia de ${name})`, cta: "Crear plantilla" },
  edit: { title: (name) => `Editar ${name}`, cta: "Guardar cambios" },
};

export function BlueprintEditor({
  mode,
  blueprintId,
  initialBlueprint,
  usageCount,
  account,
}: {
  mode: EditorMode;
  blueprintId?: string;
  initialBlueprint: BlueprintDefinition | null;
  usageCount: number;
  account: ShellAccount;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<EditorDraft>(() => draftFromBlueprint(initialBlueprint));
  const [step, setStep] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (isDirty && !isSaving) e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty, isSaving]);

  const sourceName = initialBlueprint?.name ?? "";
  const copy = MODE_COPY[mode];

  function markDirty() {
    setIsDirty(true);
  }

  function addStage() {
    setDraft((d) => ({ ...d, stages: [...d.stages, { draftId: uid("s"), name: "" }] }));
    markDirty();
  }
  function removeStage(draftId: string) {
    const affected = draft.requirements.filter((r) => r.stageDraftId === draftId);
    if (affected.length > 0) {
      const ok = window.confirm(
        `${affected.length} requisitos usan esta etapa. Si la eliminas, quedarán sin etapa.`,
      );
      if (!ok) return;
    }
    setDraft((d) => ({
      ...d,
      stages: d.stages.filter((s) => s.draftId !== draftId),
      requirements: d.requirements.map((r) => (r.stageDraftId === draftId ? { ...r, stageDraftId: null } : r)),
    }));
    markDirty();
  }
  function moveStage(index: number, direction: -1 | 1) {
    setDraft((d) => {
      const stages = [...d.stages];
      const target = index + direction;
      if (target < 0 || target >= stages.length) return d;
      [stages[index], stages[target]] = [stages[target]!, stages[index]!];
      return { ...d, stages };
    });
    markDirty();
  }

  function addParticipantTemplate() {
    setDraft((d) => ({
      ...d,
      participantTemplates: [...d.participantTemplates, { draftId: uid("p"), roleKey: "", keyTouched: false, displayName: "" }],
    }));
    markDirty();
  }
  function removeParticipantTemplate(draftId: string) {
    const affected = draft.requirements.filter((r) => r.participantRoleDraftId === draftId);
    if (affected.length > 0) {
      const ok = window.confirm(
        `Este rol tiene ${affected.length} requisitos asociados. Al eliminarlo también se eliminarán esos requisitos.`,
      );
      if (!ok) return;
    }
    setDraft((d) => ({
      ...d,
      participantTemplates: d.participantTemplates.filter((t) => t.draftId !== draftId),
      requirements: d.requirements.filter((r) => r.participantRoleDraftId !== draftId),
    }));
    markDirty();
  }
  function updateParticipantDisplayName(draftId: string, displayName: string) {
    setDraft((d) => ({
      ...d,
      participantTemplates: d.participantTemplates.map((t) =>
        t.draftId === draftId
          ? { ...t, displayName, roleKey: t.keyTouched ? t.roleKey : slugify(displayName) }
          : t,
      ),
    }));
    markDirty();
  }
  function updateParticipantRoleKey(draftId: string, roleKey: string) {
    setDraft((d) => ({
      ...d,
      participantTemplates: d.participantTemplates.map((t) =>
        t.draftId === draftId ? { ...t, roleKey, keyTouched: true } : t,
      ),
    }));
    markDirty();
  }

  function addRequirement() {
    setDraft((d) => ({
      ...d,
      requirements: [
        ...d.requirements,
        { stageDraftId: null, participantRoleDraftId: null, key: "", keyTouched: false, type: "document", label: "", scope: "case" },
      ],
    }));
    markDirty();
  }
  function removeRequirement(index: number) {
    setDraft((d) => ({ ...d, requirements: d.requirements.filter((_, i) => i !== index) }));
    markDirty();
  }
  function updateRequirement(index: number, patch: Partial<DraftRequirement>) {
    setDraft((d) => ({
      ...d,
      requirements: d.requirements.map((r, i) => {
        if (i !== index) return r;
        const next = { ...r, ...patch };
        if (patch.label !== undefined && !r.keyTouched) next.key = slugify(patch.label);
        if (patch.key !== undefined) next.keyTouched = true;
        return next;
      }),
    }));
    markDirty();
  }

  const canAdvanceStep0 = draft.name.trim().length > 0;
  const canAdvanceStep1 = draft.stages.every((s) => s.name.trim().length > 0);
  const canAdvanceStep2 = draft.participantTemplates.every(
    (t) => t.displayName.trim().length > 0 && t.roleKey.trim().length > 0,
  );

  function validateFullDraft(): boolean {
    try {
      validateBlueprintStructure(serializeDraftToNormalizedBlueprint(draft));
      setStepError(null);
      return true;
    } catch (e) {
      if (e instanceof BlueprintIntegrityError) {
        setStepError(BLUEPRINT_INTEGRITY_MESSAGES[e.code] ?? "La plantilla tiene datos inválidos.");
      } else {
        setStepError("La plantilla tiene datos inválidos.");
      }
      return false;
    }
  }

  function goNext() {
    if (step === 0 && !canAdvanceStep0) return;
    if (step === 1 && !canAdvanceStep1) return;
    if (step === 2 && !canAdvanceStep2) return;
    // Full structural validation runs when leaving Requisitos (step 3) and entering Revisión —
    // not on every step, since an in-progress draft with no requirements yet is still valid.
    if (step === 3 && !validateFullDraft()) return;
    setStep((s) => Math.min(4, s + 1));
  }
  function goBack() {
    setStep((s) => Math.max(0, s - 1) as typeof s);
  }

  function requestLeave(action: () => void) {
    if (isDirty && !isSaving) {
      setConfirmingLeave(true);
      return;
    }
    action();
  }

  async function handleSave() {
    if (!validateFullDraft()) return;
    setIsSaving(true);
    setSaveError(null);
    const normalized = serializeDraftToNormalizedBlueprint(draft);
    const payload = toSaveBlueprintPayload(normalized, mode === "edit" ? blueprintId : undefined);
    const result = await saveBlueprintAction(payload);
    setIsSaving(false);
    if (!result.ok) {
      const detail = result.issues?.length
        ? ` (${result.issues.map((i) => i.message).join("; ")})`
        : "";
      setSaveError(result.message + detail);
      return;
    }
    setIsDirty(false);
    router.push("/blueprints");
  }

  async function handleDelete() {
    if (!blueprintId) return;
    setIsSaving(true);
    const result = await deleteBlueprintAction(blueprintId);
    setIsSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      setConfirmingDelete(false);
      return;
    }
    router.push("/blueprints");
  }

  const roleOptions = useMemo(
    () => draft.participantTemplates.filter((t) => t.roleKey.trim().length > 0),
    [draft.participantTemplates],
  );

  return (
    <AppShell active="blueprints" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">{copy.title(sourceName)}</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        {mode === "edit" && usageCount > 0 && (
          <div className="mb-5 rounded-input border border-royal-100 bg-royal-50 px-4 py-3 text-sm text-royal-700">
            Esta plantilla ya se usó en {usageCount} expediente{usageCount === 1 ? "" : "s"}. Los
            cambios no afectan expedientes existentes.
          </div>
        )}

        <div className="mb-6 flex gap-2">
          {STEP_LABELS.map((label, i) => (
            <div
              key={label}
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
                i === step ? "bg-royal-600 text-white" : "bg-app-bg text-text-secondary"
              }`}
            >
              {label}
            </div>
          ))}
        </div>

        {stepError && <p className="mb-4 text-sm text-error">{stepError}</p>}
        {saveError && <p className="mb-4 text-sm text-error">{saveError}</p>}

        {step === 0 && (
          <div className="flex max-w-lg flex-col gap-4">
            <div>
              <label className="text-sm font-medium text-text-primary">Nombre</label>
              <input
                value={draft.name}
                onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); markDirty(); }}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">Descripción</label>
              <textarea
                value={draft.description}
                onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })); markDirty(); }}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex max-w-lg flex-col gap-3">
            {draft.stages.length === 0 && (
              <p className="text-sm text-text-secondary">Sin etapas. Esto es opcional.</p>
            )}
            {draft.stages.map((s, i) => (
              <div key={s.draftId} className="flex items-center gap-2">
                <input
                  value={s.name}
                  onChange={(e) => {
                    setDraft((d) => ({
                      ...d,
                      stages: d.stages.map((st) => (st.draftId === s.draftId ? { ...st, name: e.target.value } : st)),
                    }));
                    markDirty();
                  }}
                  className="flex-1 rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                />
                <button type="button" onClick={() => moveStage(i, -1)} disabled={i === 0} className="rounded-input p-1.5 disabled:opacity-30">
                  <IconChevronUp className="size-4" />
                </button>
                <button type="button" onClick={() => moveStage(i, 1)} disabled={i === draft.stages.length - 1} className="rounded-input p-1.5 disabled:opacity-30">
                  <IconChevronDown className="size-4" />
                </button>
                <button type="button" onClick={() => removeStage(s.draftId)} className="rounded-input p-1.5 text-error">
                  <IconTrash className="size-4" />
                </button>
              </div>
            ))}
            <button type="button" onClick={addStage} className="flex w-fit items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm">
              <IconPlus className="size-4" /> Agregar etapa
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="flex max-w-lg flex-col gap-3">
            {draft.participantTemplates.map((t) => (
              <div key={t.draftId} className="flex items-center gap-2">
                <input
                  placeholder="Nombre del rol"
                  value={t.displayName}
                  onChange={(e) => updateParticipantDisplayName(t.draftId, e.target.value)}
                  className="flex-1 rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                />
                <input
                  placeholder="identificador-slug"
                  value={t.roleKey}
                  onChange={(e) => updateParticipantRoleKey(t.draftId, e.target.value)}
                  className="w-40 rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                />
                <button type="button" onClick={() => removeParticipantTemplate(t.draftId)} className="rounded-input p-1.5 text-error">
                  <IconTrash className="size-4" />
                </button>
              </div>
            ))}
            <button type="button" onClick={addParticipantTemplate} className="flex w-fit items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm">
              <IconPlus className="size-4" /> Agregar rol
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="flex max-w-2xl flex-col gap-4">
            {draft.requirements.map((r, i) => (
              <div key={i} className="rounded-input border border-border p-4">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    placeholder="Etiqueta"
                    value={r.label}
                    onChange={(e) => updateRequirement(i, { label: e.target.value })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  />
                  <input
                    placeholder="clave-slug"
                    value={r.key}
                    onChange={(e) => updateRequirement(i, { key: e.target.value })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  />
                  <select
                    value={r.scope}
                    onChange={(e) => updateRequirement(i, { scope: e.target.value as "case" | "participant", participantRoleDraftId: null })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  >
                    <option value="case">Expediente</option>
                    {roleOptions.length > 0 && <option value="participant">Participante</option>}
                  </select>
                  {r.scope === "participant" && (
                    <select
                      value={r.participantRoleDraftId ?? ""}
                      onChange={(e) => updateRequirement(i, { participantRoleDraftId: e.target.value })}
                      className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                    >
                      <option value="">Selecciona un rol</option>
                      {roleOptions.map((t) => (
                        <option key={t.draftId} value={t.draftId}>{t.displayName}</option>
                      ))}
                    </select>
                  )}
                  <select
                    value={r.stageDraftId ?? ""}
                    onChange={(e) => updateRequirement(i, { stageDraftId: e.target.value || null })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  >
                    <option value="">Sin etapa</option>
                    {draft.stages.map((s) => (
                      <option key={s.draftId} value={s.draftId}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <button type="button" onClick={() => removeRequirement(i)} className="mt-2 flex items-center gap-1.5 text-sm text-error">
                  <IconTrash className="size-4" /> Eliminar requisito
                </button>
              </div>
            ))}
            <button type="button" onClick={addRequirement} className="flex w-fit items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm">
              <IconPlus className="size-4" /> Agregar requisito
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="max-w-lg text-sm text-text-secondary">
            <p><strong className="text-text-primary">{draft.name}</strong></p>
            <p className="mt-2">{draft.stages.length} etapas · {draft.participantTemplates.length} roles ·{" "}
              {draft.requirements.filter((r) => r.scope === "case").length} requisitos de expediente ·{" "}
              {draft.requirements.filter((r) => r.scope === "participant").length} requisitos de participante</p>
          </div>
        )}

        <div className="mt-8 flex items-center gap-3">
          {step > 0 && (
            <button type="button" onClick={goBack} className="flex items-center gap-1.5 rounded-input border border-border px-3.5 py-2 text-sm">
              <IconArrowLeft className="size-4" /> Atrás
            </button>
          )}
          {step < 4 && (
            <button
              type="button"
              onClick={goNext}
              disabled={
                (step === 0 && !canAdvanceStep0) ||
                (step === 1 && !canAdvanceStep1) ||
                (step === 2 && !canAdvanceStep2)
              }
              className="flex items-center gap-1.5 rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              Siguiente <IconArrowRight className="size-4" />
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {isSaving ? "Guardando…" : copy.cta}
            </button>
          )}
          <button
            type="button"
            onClick={() => requestLeave(() => router.push("/blueprints"))}
            className="rounded-input border border-border px-3.5 py-2 text-sm"
          >
            Cancelar
          </button>
          {mode === "edit" && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="ml-auto flex items-center gap-1.5 rounded-input border border-error px-3.5 py-2 text-sm text-error"
            >
              <IconTrash className="size-4" /> Eliminar
            </button>
          )}
        </div>
      </div>

      {confirmingLeave && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-royal-50 text-royal-600">
              <IconShield className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Cambios sin guardar</h2>
            <p className="mt-2 text-sm text-text-secondary">Tienes cambios sin guardar. ¿Quieres salir de todos modos?</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmingLeave(false)} className="rounded-input border border-border px-3.5 py-2 text-sm">
                Seguir editando
              </button>
              <button
                type="button"
                onClick={() => { setConfirmingLeave(false); router.push("/blueprints"); }}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white"
              >
                Salir sin guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-error/10 text-error">
              <IconTrash className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Eliminar plantilla</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Esta acción es permanente.
              {usageCount > 0 && " Los expedientes ya creados no se verán afectados."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded-input border border-border px-3.5 py-2 text-sm">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isSaving}
                className="rounded-input bg-error px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {isSaving ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
