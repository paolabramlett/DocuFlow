"use client";

/*
 * Cases workspace — the interactive shell. Fed real data by the Server Component in page.tsx;
 * this file owns only selection state and presentation. Design per DESIGN.md.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconCheck, IconClock, IconDot, IconEye, IconPlus, IconSearch, IconX, type IconProps } from "@/components/icons";
import type { CaseView, OperativeCounts, ParticipantView, ReqDisplayState, RequirementView } from "@/features/cases/queries";
import { closeCaseAction, getDocumentDownloadUrlAction, reopenCaseAction, reviewDocumentAction, sendManualReminderAction } from "./actions";

const REQ: Record<ReqDisplayState, { label: string; fg: string; bg: string; bar: string; Icon: (p: IconProps) => React.ReactElement }> = {
  approved: { label: "Aprobado", fg: "text-success", bg: "bg-success-bg", bar: "bg-success", Icon: IconCheck },
  review: { label: "En revisión", fg: "text-review", bg: "bg-review-bg", bar: "bg-review", Icon: IconEye },
  awaiting: { label: "Pendiente", fg: "text-warning", bg: "bg-warning-bg", bar: "bg-warning", Icon: IconClock },
  rejected: { label: "Rechazado", fg: "text-error", bg: "bg-error-bg", bar: "bg-error", Icon: IconX },
  missing: { label: "Sin iniciar", fg: "text-neutral", bg: "bg-neutral-bg", bar: "bg-neutral", Icon: IconDot },
};

const flat = (c: CaseView) => c.participants.flatMap((p) => p.requirements);
function counts(reqs: RequirementView[]) {
  return {
    approved: reqs.filter((r) => r.state === "approved").length,
    review: reqs.filter((r) => r.state === "review").length,
    awaiting: reqs.filter((r) => r.state === "awaiting").length,
    rejected: reqs.filter((r) => r.state === "rejected").length,
    missing: reqs.filter((r) => r.state === "missing").length,
    total: reqs.length,
  };
}
const pct = (reqs: RequirementView[]) => (reqs.length ? Math.round((counts(reqs).approved / reqs.length) * 100) : 0);

export function CasesWorkspace({ cases, counts: op, account }: { cases: CaseView[]; counts: OperativeCounts; account: ShellAccount }) {
  const [selectedId, setSelectedId] = useState(cases[0]?.id ?? null);
  const selected = cases.find((c) => c.id === selectedId) ?? cases[0] ?? null;

  return (
    <AppShell active="cases" account={account}>
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

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Summary label="Esperando al cliente" value={op.waitingClient} tint="bg-warning" />
          <Summary label="Por revisar" value={op.needsReview} tint="bg-review" />
          <Summary label="Documentación completa" value={op.readyToContinue} tint="bg-success" />
          <Summary label="Completados hoy" value={op.completedToday} tint="bg-neutral" />
        </div>

        {cases.length === 0 ? (
          <EmptyCases />
        ) : (
          <div className="flex min-h-0 flex-1 gap-6">
            <div className="flex w-[320px] shrink-0 flex-col overflow-hidden rounded-panel border border-border bg-surface shadow-sm">
              <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
                <span className="text-sm font-semibold text-text-primary">Todos los expedientes</span>
                <span className="rounded-full bg-app-bg px-2 py-0.5 text-xs font-medium text-text-secondary tabular">{cases.length}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {cases.map((c) => <CaseRow key={c.id} c={c} selected={c.id === selected?.id} onSelect={() => setSelectedId(c.id)} />)}
              </div>
            </div>
            <div className="min-w-0 flex-1 overflow-hidden rounded-panel border border-border bg-surface shadow-md">
              {selected && <CaseDetail c={selected} />}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Summary({ label, value, tint }: { label: string; value: number; tint: string }) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-3">
      <span className={`size-2.5 shrink-0 rounded-full ${tint}`} />
      <div>
        <div className="text-lg font-semibold tabular text-text-primary">{value}</div>
        <div className="text-xs text-text-secondary">{label}</div>
      </div>
    </div>
  );
}

function EmptyCases() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center rounded-panel border border-dashed border-border bg-surface py-16 text-center">
      <p className="text-sm font-semibold text-text-primary">Aún no tienes expedientes</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">Crea el primero desde una plantilla e invita a los participantes.</p>
      <Link href="/cases/new" className="mt-4 rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">Nuevo expediente</Link>
    </div>
  );
}

function CaseRow({ c, selected, onSelect }: { c: CaseView; selected: boolean; onSelect: () => void }) {
  const reqs = flat(c);
  const { approved, total } = counts(reqs);
  const p = pct(reqs);
  const done = total > 0 && approved === total;
  return (
    <button onClick={onSelect} className={`relative w-full border-b border-border px-4 py-4 text-left transition-colors ${selected ? "bg-royal-50" : "hover:bg-app-bg"}`}>
      {selected && <span className="absolute left-0 top-0 h-full w-[3px] bg-royal-600" />}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-text-secondary tabular">{c.ref}</span>
        {done ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success"><IconCheck className="size-3.5" />Documentación completa</span>
        ) : (
          <span className="text-xs font-medium text-text-secondary tabular">{approved}/{total}</span>
        )}
      </div>
      <div className="mt-1 text-sm font-semibold text-text-primary">{c.title}</div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-app-bg">
        <div className="h-full rounded-full bg-royal-500 transition-[width] duration-500 ease-out" style={{ width: `${p}%` }} />
      </div>
    </button>
  );
}

function ParticipantColumn({ p, caseOpen }: { p: ParticipantView; caseOpen: boolean }) {
  const c = counts(p.requirements);
  const pc = pct(p.requirements);
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
            {pc === 100 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-1 text-xs font-semibold text-success"><IconCheck className="size-3.5" /> Completo</span>
            ) : (
              <div className="text-lg font-semibold tabular text-text-primary">{pc}%</div>
            )}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-app-bg">
            <div className="h-full rounded-full bg-royal-500 transition-[width] duration-500 ease-out" style={{ width: `${pc}%` }} />
          </div>
          {pc === 100 && <span className="flex size-4 items-center justify-center rounded-full bg-success text-white"><IconCheck className="size-3" /></span>}
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary tabular">
          <span>{c.approved} aprobados</span>
          {c.review > 0 && <span>{c.review} en revisión</span>}
          {c.rejected > 0 && <span className="text-error">{c.rejected} rechazados</span>}
          {c.missing + c.awaiting > 0 && <span>{c.missing + c.awaiting} pendientes</span>}
        </div>
      </div>
      <ul className="flex-1">
        {p.requirements.map((r) => <RequirementRow key={r.id} r={r} caseOpen={caseOpen} />)}
      </ul>
    </div>
  );
}

function RequirementRow({ r, caseOpen }: { r: RequirementView; caseOpen: boolean }) {
  const m = REQ[r.state];
  const [busy, setBusy] = useState<"approve" | "reject" | "view" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function view() {
    if (!r.documentId) return;
    // Opened synchronously, before the await, so browser popup blockers see it as a direct
    // response to the click — setting .location once the signed URL is ready, rather than
    // calling window.open() only after the async round-trip, which most blockers reject.
    // Deliberately no "noopener": that flag makes window.open() return null (per spec, since the
    // whole point is severing the reference), which would leave this blank tab permanently
    // un-navigable. The destination is our own freshly-minted signed URL, not third-party
    // attacker content, so the usual reverse-tabnabbing reason for noopener doesn't apply here.
    const tab = window.open("", "_blank");
    setBusy("view");
    setError(null);
    const result = await getDocumentDownloadUrlAction(r.documentId);
    setBusy(null);
    if (!result.ok) {
      tab?.close();
      setError(result.message);
      return;
    }
    if (tab) tab.location.href = result.data;
  }

  async function approve() {
    if (!r.documentId) return;
    setBusy("approve");
    setError(null);
    const result = await reviewDocumentAction({ documentId: r.documentId, decision: "approved" });
    setBusy(null);
    if (!result.ok) { setError(result.message); return; }
    router.refresh();
  }

  async function reject() {
    if (!r.documentId || !reason.trim()) return;
    setBusy("reject");
    setError(null);
    const result = await reviewDocumentAction({ documentId: r.documentId, decision: "rejected", reason });
    setBusy(null);
    if (!result.ok) { setError(result.message); return; }
    setRejecting(false);
    setReason("");
    router.refresh();
  }

  return (
    <li id={`req-${r.id}`} className="border-b border-border px-5 py-3 last:border-b-0">
      <div className="flex items-center gap-3">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-full ${m.bg} ${m.fg}`}><m.Icon className="size-3.5" /></span>
        <span className="flex-1 text-sm text-text-primary">{r.label}</span>
        {r.state === "review" && r.documentId && caseOpen ? (
          <div className="flex items-center gap-1.5">
            <button
              onClick={view}
              disabled={busy !== null}
              className="rounded-input border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "view" ? "Abriendo…" : "Ver documento"}
            </button>
            <button
              onClick={approve}
              disabled={busy !== null}
              className="rounded-input bg-success px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "approve" ? "Aprobando…" : "Aprobar"}
            </button>
            <button
              onClick={() => setRejecting((v) => !v)}
              disabled={busy !== null}
              className="rounded-input border border-error/30 bg-error-bg px-2.5 py-1 text-xs font-semibold text-error transition-colors hover:bg-error/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Rechazar
            </button>
          </div>
        ) : r.state === "approved" && r.documentId ? (
          <div className="flex items-center gap-2">
            <button
              onClick={view}
              disabled={busy !== null}
              className="rounded-input border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "view" ? "Abriendo…" : "Ver documento"}
            </button>
            <span className={`text-xs font-medium ${m.fg}`}>{m.label}</span>
          </div>
        ) : (
          <span className={`text-xs font-medium ${m.fg}`}>{m.label}</span>
        )}
      </div>

      {rejecting && (
        <div className="mt-2.5 rounded-input border border-error/20 bg-error-bg/40 p-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-primary">Motivo del rechazo (el cliente lo verá)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="ej. Falta la segunda página del documento."
              className="w-full rounded-input border border-border bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-error focus:ring-2 focus:ring-error/15"
            />
          </label>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={reject}
              disabled={busy !== null || !reason.trim()}
              className="rounded-input bg-error px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "reject" ? "Enviando…" : "Confirmar rechazo"}
            </button>
            <button onClick={() => { setRejecting(false); setReason(""); }} className="text-xs font-medium text-text-secondary hover:text-text-primary">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-1.5 text-xs text-error">{error}</p>}
    </li>
  );
}

function CaseDetail({ c }: { c: CaseView }) {
  const reqs = flat(c);
  const k = counts(reqs);
  const p = pct(reqs);
  const done = k.total > 0 && k.approved === k.total;
  const [reminding, setReminding] = useState(false);
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);
  const [reopenMessage, setReopenMessage] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);

  const segments = reqs;
  const firstReview = reqs.find((r) => r.state === "review");

  function goToReview() {
    if (!firstReview) return;
    document.getElementById(`req-${firstReview.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function remind() {
    setReminding(true);
    setReminderMessage(null);
    const result = await sendManualReminderAction(c.id);
    setReminding(false);
    if (!result.ok) {
      setReminderMessage(result.message);
      return;
    }
    const { remindedCount, failures } = result.data;
    if (remindedCount === 0 && failures.length === 0) {
      setReminderMessage("Nadie tiene documentos pendientes para recordar.");
    } else if (failures.length > 0) {
      setReminderMessage(
        `Recordatorio enviado a ${remindedCount} participante${remindedCount === 1 ? "" : "s"}. No pudimos enviarlo a ${failures.length}${remindedCount > 0 ? " más" : ""}.`,
      );
    } else {
      setReminderMessage(`Recordatorio enviado a ${remindedCount} participante${remindedCount > 1 ? "s" : ""}.`);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4 border-b border-border px-7 py-5">
        <div>
          <div className="font-mono text-xs text-text-secondary tabular">{c.ref}</div>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-text-primary">{c.title}</h2>
          <p className="mt-1 text-sm text-text-secondary">{c.participants.length} participante{c.participants.length > 1 ? "s" : ""} · abierto el {c.opened}</p>
          {reminderMessage && <p className="mt-1 text-xs text-text-secondary">{reminderMessage}</p>}
          {reopenMessage && <p className="mt-1 text-xs text-text-secondary">{reopenMessage}</p>}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/cases/${c.id}/documents-zip`}
            className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
          >
            Descargar todo
          </a>
          {c.state === "open" && (
            <>
              <button
                onClick={remind}
                disabled={reminding}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reminding ? "Enviando…" : "Recordar"}
              </button>
              <button
                onClick={goToReview}
                disabled={!firstReview}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Revisar documentos
              </button>
              <button
                onClick={() => setClosing(true)}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
              >
                Cerrar expediente
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        {done && c.state === "open" && (
          <div className="mb-6 flex items-center gap-3 rounded-card border border-success/20 bg-success-bg/60 px-5 py-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success text-white"><IconCheck className="size-4" /></span>
            <div>
              <div className="text-sm font-semibold text-text-primary">Documentación completa</div>
              <p className="text-xs text-text-secondary">Todos los documentos requeridos fueron aprobados. El expediente sigue abierto hasta que lo marques como finalizado.</p>
            </div>
          </div>
        )}
        {c.state !== "open" && <ClosureBanner c={c} onReopened={(msg: string | null) => setReopenMessage(msg)} />}
        <section>
          <div className="flex items-end justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Progreso del expediente</span>
            <span className="text-3xl font-semibold tabular text-text-primary">{p}%</span>
          </div>
          <div className="mt-3 flex gap-1">
            {segments.map((r) => (
              <div key={r.id} className={`h-2.5 flex-1 rounded-full ${REQ[r.state].bar}`} title={REQ[r.state].label} style={{ opacity: r.state === "missing" ? 0.35 : 1 }} />
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

        <section className="mt-8">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Participantes</h3>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {c.participants.map((pt) => <ParticipantColumn key={pt.id} p={pt} caseOpen={c.state === "open"} />)}
          </div>
        </section>
      </div>
      {closing && <CloseCaseModal caseId={c.id} documentationComplete={done} onClose={() => setClosing(false)} />}
    </div>
  );
}

function formatClosedAt(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Mexico_City",
  });
}

function ClosureBanner({ c, onReopened }: { c: CaseView; onReopened: (msg: string | null) => void }) {
  const [reopening, setReopening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const completed = c.state === "completed";

  async function reopen() {
    setReopening(true);
    setMessage(null);
    onReopened(null);
    const result = await reopenCaseAction(c.id);
    setReopening(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    if (result.data.requiresReinvitation) {
      onReopened("El cliente ya no tiene un enlace activo — usa Recordar para invitarlo de nuevo.");
    } else if (result.data.notificationFailureCount > 0) {
      const n = result.data.notificationFailureCount;
      onReopened(`Se restauró el acceso, pero no pudimos notificar a ${n} participante${n === 1 ? "" : "s"} — usa Recordar.`);
    } else {
      onReopened(null);
    }
    router.refresh();
  }

  return (
    <div className={`mb-6 flex items-start gap-3 rounded-card border px-5 py-4 ${completed ? "border-success/20 bg-success-bg/60" : "border-border bg-app-bg"}`}>
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-full text-white ${completed ? "bg-success" : "bg-neutral"}`}>
        {completed ? <IconCheck className="size-4" /> : <IconX className="size-4" />}
      </span>
      <div className="flex-1">
        <div className="text-sm font-semibold text-text-primary">
          {completed ? "Expediente completado" : "Expediente cancelado"}
        </div>
        <p className="mt-0.5 text-xs text-text-secondary">
          {c.closedAt && `Cerrado el ${formatClosedAt(c.closedAt)}.`}
          {c.clientClosingNote && ` ${c.clientClosingNote}`}
        </p>
        {message && <p className="mt-1 text-xs text-text-secondary">{message}</p>}
        <button
          onClick={reopen}
          disabled={reopening}
          className="mt-2.5 rounded-input border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-primary transition-colors hover:bg-app-bg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reopening ? "Reabriendo…" : "Reabrir expediente"}
        </button>
      </div>
    </div>
  );
}

function CloseCaseModal({
  caseId,
  documentationComplete,
  onClose,
}: {
  caseId: string;
  documentationComplete: boolean;
  onClose: () => void;
}) {
  const [outcome, setOutcome] = useState<"completed" | "cancelled" | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function submit() {
    if (!outcome) return;
    if (outcome === "cancelled" && !note.trim()) return;
    setSubmitting(true);
    setError(null);
    const result = await closeCaseAction(caseId, outcome, note.trim() || undefined);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onClose();
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-panel border border-border bg-surface p-6 shadow-md">
        <h3 className="text-sm font-semibold text-text-primary">Cerrar expediente</h3>
        <div className="mt-4 space-y-3">
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="outcome"
              disabled={!documentationComplete}
              checked={outcome === "completed"}
              onChange={() => setOutcome("completed")}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium text-text-primary">Completado</span>
              {!documentationComplete && (
                <span className="block text-xs text-text-secondary">Requiere documentación completa.</span>
              )}
            </span>
          </label>
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              name="outcome"
              checked={outcome === "cancelled"}
              onChange={() => setOutcome("cancelled")}
              className="mt-0.5"
            />
            <span className="block text-sm font-medium text-text-primary">Cancelado</span>
          </label>
        </div>

        {outcome === "cancelled" && (
          <label className="mt-3 block">
            <span className="mb-1 block text-xs font-medium text-text-primary">Motivo de cancelación (el cliente lo verá)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-input border border-border bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            />
          </label>
        )}

        {error && <p className="mt-2 text-xs text-error">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-input px-3.5 py-2 text-sm font-medium text-text-secondary hover:text-text-primary">
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={submitting || !outcome || (outcome === "cancelled" && !note.trim())}
            className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Cerrando…" : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}
