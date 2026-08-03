"use client";

/*
 * The Client Portal, as one page with one question: "what do I need to do next?"
 * Governed by docs/CLIENT_PORTAL.md — read it before changing this file.
 *
 * No sidebar, no navigation, no progress bar as hero. A single state machine:
 *   landing -> otp -> checklist -> (complete)
 * or straight to 'checklist' / 'error' when the server already resolved which one applies.
 */

import { useRef, useState } from "react";
import type { FailureReason } from "@/application/errors";
import type { InvitationLanding, PortalState } from "@/application/client-portal";
import type { PortalRequirement } from "@/features/case-access/portal-queries";
import {
  getClientDocumentUrlAction,
  requestAccessCodeAction,
  uploadRequirementDocumentAction,
  verifyAccessCodeAction,
  getPortalStateAction,
} from "../actions";
import {
  IconCheck,
  IconClock,
  IconDocument,
  IconEye,
  IconRefresh,
  IconShield,
  IconUpload,
  IconX,
  type IconProps,
} from "@/components/icons";

type Failure = { reason: FailureReason; message: string };

type Props =
  | { token: string; mode: "checklist"; initialState: PortalState }
  | { token: string; mode: "landing"; landing: InvitationLanding }
  | { token: string; mode: "error"; error: Failure };

type View = "landing" | "otp" | "checklist" | "error";

const META: Record<
  PortalRequirement["state"],
  { label: string; fg: string; bg: string; Icon: (p: IconProps) => React.ReactElement }
> = {
  pending: { label: "Pendiente", fg: "text-warning", bg: "bg-warning-bg", Icon: IconClock },
  review: { label: "En revisión", fg: "text-review", bg: "bg-review-bg", Icon: IconEye },
  approved: { label: "Aprobado", fg: "text-success", bg: "bg-success-bg", Icon: IconCheck },
  rejected: { label: "Rechazado", fg: "text-error", bg: "bg-error-bg", Icon: IconX },
};

function Brand() {
  return (
    <div className="mb-6 flex justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/img/Logo-1.png" alt="Avanza" className="h-6 w-auto" />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-app-bg px-5 py-10">
      <div className="w-full max-w-md">
        <Brand />
        {children}
      </div>
    </div>
  );
}

export function PortalClient(props: Props) {
  const [view, setView] = useState<View>(props.mode === "landing" ? "landing" : props.mode);
  const [landing] = useState<InvitationLanding | null>(props.mode === "landing" ? props.landing : null);
  const [error, setError] = useState<Failure | null>(props.mode === "error" ? props.error : null);
  const [state, setState] = useState<PortalState | null>(props.mode === "checklist" ? props.initialState : null);

  async function refreshState() {
    const result = await getPortalStateAction(props.token);
    if (result.ok) {
      setState(result.data);
      setView("checklist");
    } else {
      setError({ reason: result.reason, message: result.message });
      setView("error");
    }
  }

  if (view === "error" && error) {
    return (
      <Shell>
        <ErrorCard error={error} />
      </Shell>
    );
  }

  if (view === "landing" && landing) {
    return (
      <Shell>
        <LandingCard
          landing={landing}
          token={props.token}
          onSent={() => setView("otp")}
          onFail={(f) => {
            setError(f);
            setView("error");
          }}
        />
      </Shell>
    );
  }

  if (view === "otp") {
    return (
      <Shell>
        <OtpCard
          token={props.token}
          onVerified={refreshState}
          onFail={(f) => {
            setError(f);
            setView("error");
          }}
        />
      </Shell>
    );
  }

  if (view === "checklist" && state) {
    return <Checklist token={props.token} state={state} onChanged={refreshState} />;
  }

  return (
    <Shell>
      <ErrorCard error={{ reason: "unexpected", message: "Algo no salió como esperábamos." }} />
    </Shell>
  );
}

// ---------- Dedicated error states — one per FailureReason, never a generic message ----------
function ErrorCard({ error }: { error: Failure }) {
  const COPY: Record<FailureReason, string> = {
    unauthenticated: "Tu sesión expiró. Vuelve a abrir el enlace que te enviaron.",
    forbidden: "Este acceso ya no está disponible.",
    validation: "Algo no es válido.",
    not_found: "No encontramos lo que buscas.",
    conflict: "Ya habías hecho esto antes.",
    delivery_failed: "No pudimos completar esto. Inténtalo de nuevo.",
    unexpected: "Algo falló de nuestro lado.",
  };

  return (
    <div className="rounded-panel border border-border bg-surface p-7 text-center shadow-md sm:p-8">
      <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-error-bg text-error">
        <IconX className="size-6" />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-text-primary">{COPY[error.reason]}</h1>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">{error.message}</p>
    </div>
  );
}

// ---------- 1 · Landing ----------
function LandingCard({
  landing,
  token,
  onSent,
  onFail,
}: {
  landing: InvitationLanding;
  token: string;
  onSent: () => void;
  onFail: (f: Failure) => void;
}) {
  const [pending, setPending] = useState(false);

  async function send() {
    setPending(true);
    const result = await requestAccessCodeAction(token);
    setPending(false);
    if (result.ok) onSent();
    else onFail({ reason: result.reason, message: result.message });
  }

  return (
    <div className="rounded-panel border border-border bg-surface p-7 shadow-md sm:p-8">
      <div className="text-sm font-medium text-royal-600">{landing.organizationName}</div>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">
        {landing.alreadyVerified ? "Confirma tu acceso de nuevo" : "Te invitaron a completar tu expediente"}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
        Se trata de <span className="font-medium text-text-primary">{landing.caseTitle}</span>.{" "}
        {landing.alreadyVerified
          ? "Pide un código para volver a entrar."
          : "Solo tendrás que subir algunos documentos — sin crear cuenta."}
      </p>

      <div className="mt-5 flex items-start gap-3 rounded-card bg-royal-50 px-4 py-3">
        <IconShield className="mt-0.5 size-5 shrink-0 text-royal-600" />
        <p className="text-sm text-text-secondary">
          Te enviaremos un <span className="font-medium text-text-primary">código de acceso</span> a tu correo.
          Solo tú puedes abrir el expediente.
        </p>
      </div>

      <button
        onClick={send}
        disabled={pending}
        className="mt-6 w-full rounded-input bg-royal-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Enviando…" : "Enviar código de acceso"}
      </button>
    </div>
  );
}

// ---------- 2 · OTP ----------
function OtpCard({
  token,
  onVerified,
  onFail,
}: {
  token: string;
  onVerified: () => void;
  onFail: (f: Failure) => void;
}) {
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [pending, setPending] = useState(false);
  const [resent, setResent] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  function setDigit(i: number, v: string) {
    const clean = v.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    setInlineError(null);
    if (clean && i < 5) refs.current[i + 1]?.focus();
  }

  function onKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  }

  async function verify() {
    const code = digits.join("");
    if (code.length !== 6) {
      setInlineError("Ingresa los 6 dígitos del código.");
      return;
    }
    setPending(true);
    const result = await verifyAccessCodeAction(token, code);
    setPending(false);
    if (result.ok) onVerified();
    else if (result.reason === "validation") setInlineError(result.message);
    else onFail({ reason: result.reason, message: result.message });
  }

  async function resend() {
    setPending(true);
    const result = await requestAccessCodeAction(token);
    setPending(false);
    if (result.ok) {
      setResent(true);
      setTimeout(() => setResent(false), 4000);
    } else if (result.reason !== "validation") {
      onFail({ reason: result.reason, message: result.message });
    } else {
      setInlineError(result.message);
    }
  }

  return (
    <div className="rounded-panel border border-border bg-surface p-7 shadow-md sm:p-8">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Ingresa tu código</h1>
      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
        Te enviamos un código de 6 dígitos por correo. Vence en unos minutos.
      </p>

      <div className="mt-6 flex justify-between gap-2">
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            value={d}
            inputMode="numeric"
            maxLength={1}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => onKey(i, e)}
            className={`h-14 w-full rounded-input border bg-surface text-center text-xl font-semibold text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100 ${inlineError ? "border-error" : "border-border"}`}
          />
        ))}
      </div>
      {inlineError && <p className="mt-2 text-xs text-error">{inlineError}</p>}

      <button
        onClick={verify}
        disabled={pending}
        className="mt-6 w-full rounded-input bg-royal-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Verificando…" : "Verificar y continuar"}
      </button>

      <div className="mt-4 text-center text-sm">
        <button onClick={resend} disabled={pending} className="font-medium text-royal-600 hover:text-royal-700 disabled:opacity-60">
          {resent ? "Código reenviado" : "Reenviar código"}
        </button>
      </div>
    </div>
  );
}

// ---------- 4-8 · The checklist, pending first, with a quiet completion banner ----------
function Checklist({ token, state, onChanged }: { token: string; state: PortalState; onChanged: () => void }) {
  const pending = state.requirements.filter((r) => r.state === "pending" || r.state === "rejected");
  const resolved = state.requirements.filter((r) => r.state === "review" || r.state === "approved");
  // A Participant with zero Requirements is not "done" — there was never anything to complete
  // (design.md's documentation-complete rule: it requires at least one visible Requirement).
  const documentationComplete = state.isComplete && state.requirements.length > 0;
  // Distinct from documentationComplete: the Case itself can be closed (completed OR cancelled)
  // regardless of whether every Requirement was ever approved — a cancelled Case may have
  // Requirements left pending. This check always wins over the documentationComplete branch below.
  const caseClosed = state.caseState !== "open";

  return (
    <div className="min-h-screen bg-app-bg">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-5">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/img/Logo-1.png" alt="Avanza" className="h-6 w-auto" />
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <IconShield className="size-4 text-success" /> Sesión segura
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-7">
        <div className="text-sm font-medium text-royal-600">{state.organizationName}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text-primary">{state.caseTitle}</h1>

        {caseClosed ? (
          <>
            <ClosedCaseBanner caseState={state.caseState} clientClosingNote={state.clientClosingNote} />
            <h2 className="mb-3 mt-8 text-sm font-semibold text-text-primary">Tus documentos</h2>
            <div className="space-y-3">
              {state.requirements.map((r) => (
                <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} readOnly />
              ))}
            </div>
          </>
        ) : documentationComplete ? (
          <>
            <CompletionBanner />
            <h2 className="mb-3 mt-8 text-sm font-semibold text-text-primary">Tus documentos</h2>
            <div className="space-y-3">
              {resolved.map((r) => (
                <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* The counter is visible but quiet — never the hero (docs/CLIENT_PORTAL.md, rule 7). */}
            <p className="mt-1 text-sm text-text-secondary">
              Te falta{state.pendingCount === 1 ? "n" : ""} {state.pendingCount} de {state.requirements.length}
            </p>

            <h2 className="mb-3 mt-6 text-sm font-semibold text-text-primary">Qué necesitas hacer</h2>
            <div className="space-y-3">
              {pending.map((r) => (
                <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} />
              ))}
            </div>

            {resolved.length > 0 && (
              <>
                <h2 className="mb-3 mt-8 text-sm font-medium text-text-secondary">Ya enviado</h2>
                <div className="space-y-2 opacity-80">
                  {resolved.map((r) => (
                    <RequirementCard key={r.id} token={token} r={r} onChanged={onChanged} quiet />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        <p className="mt-8 text-center font-mono text-xs text-text-secondary/60">Avanza</p>
      </main>
    </div>
  );
}

function CompletionBanner() {
  return (
    <div className="complete-rise mt-6 rounded-card border border-success/20 bg-success-bg/60 p-6 text-center">
      <div className="complete-check mx-auto flex size-14 items-center justify-center rounded-full bg-success text-white">
        <IconCheck className="size-7" />
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary">Documentación completa</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">
        Todos tus documentos requeridos fueron aprobados. No necesitas realizar ninguna acción por el momento.
        El equipo continuará con el proceso y te notificará si necesita algo más.
      </p>
    </div>
  );
}

function ClosedCaseBanner({
  caseState,
  clientClosingNote,
}: {
  caseState: "completed" | "cancelled";
  clientClosingNote?: string;
}) {
  const completed = caseState === "completed";
  return (
    <div className={`complete-rise mt-6 rounded-card border p-6 text-center ${completed ? "border-success/20 bg-success-bg/60" : "border-border bg-app-bg"}`}>
      <div className={`mx-auto flex size-14 items-center justify-center rounded-full text-white ${completed ? "bg-success" : "bg-neutral"}`}>
        {completed ? <IconCheck className="size-7" /> : <IconX className="size-7" />}
      </div>
      <h2 className="mt-4 text-lg font-semibold text-text-primary">
        {completed ? "Expediente completado" : "Expediente cancelado"}
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">
        {clientClosingNote ?? (completed ? "Toda tu documentación requerida fue aprobada." : "Este expediente fue cancelado.")}
      </p>
    </div>
  );
}

function RequirementCard({
  token,
  r,
  onChanged,
  quiet,
  readOnly,
}: {
  token: string;
  r: PortalRequirement;
  onChanged: () => void;
  quiet?: boolean;
  readOnly?: boolean;
}) {
  const m = META[r.state];
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setBusy(true);
    setUploadError(null);
    const formData = new FormData();
    formData.set("file", file);
    const result = await uploadRequirementDocumentAction(token, r.id, formData);
    setBusy(false);

    if (result.ok) onChanged();
    else setUploadError(result.message);
  }

  async function openDocument(download: boolean) {
    if (!r.documentId) return;
    setDocError(null);
    // Opened synchronously, before the await — see cases-workspace.tsx's "Ver documento" for why
    // (a browser's popup blocker treats a post-await window.open as unrelated to the click).
    const tab = window.open("", "_blank");
    const result = await getClientDocumentUrlAction(token, r.documentId, download);
    if (!result.ok) {
      tab?.close();
      setDocError(result.message);
      return;
    }
    if (tab) tab.location.href = result.data;
  }

  return (
    <div className={`overflow-hidden rounded-card border border-border bg-surface ${quiet ? "shadow-none" : "shadow-sm"}`}>
      <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.heic,.webp" className="hidden" onChange={onFile} />
      <div className="flex items-start gap-3 px-5 py-4">
        <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-input ${m.bg} ${m.fg}`}>
          <IconDocument className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-text-primary">{r.label}</span>
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${m.fg} ${m.bg}`}>
              <m.Icon className="size-3.5" /> {m.label}
            </span>
          </div>
          {r.state === "approved" && r.fileName && (
            <p className="mt-1 truncate text-xs text-text-secondary">
              {r.approvedAt && `Aprobado el ${new Date(r.approvedAt).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })} · `}
              {r.fileName}
            </p>
          )}
        </div>
      </div>

      {r.state === "rejected" && !readOnly && (
        <div className="border-t border-border bg-error-bg/50 px-5 py-3.5">
          <p className="text-sm text-text-primary">
            <span className="font-semibold text-error">Por qué se rechazó:</span> {r.rejectionReason}
          </p>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="mt-3 inline-flex items-center gap-2 rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
          >
            <IconRefresh className="size-4" /> {busy ? "Subiendo…" : "Subir de nuevo"}
          </button>
        </div>
      )}

      {r.state === "pending" && !readOnly && (
        <div className="border-t border-border px-5 py-4">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-input border border-dashed border-royal-100 bg-royal-50/50 py-3 text-sm font-semibold text-royal-600 transition-colors hover:bg-royal-50 disabled:opacity-60"
          >
            <IconUpload className="size-4" /> {busy ? "Subiendo…" : "Subir documento"}
          </button>
        </div>
      )}

      {(readOnly ? r.documentId : r.state === "approved" && r.documentId) && (
        <div className="flex gap-2 border-t border-border px-5 py-3">
          <button
            onClick={() => openDocument(false)}
            className="flex-1 rounded-input border border-border px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-app-bg"
          >
            Ver
          </button>
          <button
            onClick={() => openDocument(true)}
            className="flex-1 rounded-input border border-border px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:bg-app-bg"
          >
            Descargar
          </button>
        </div>
      )}

      {uploadError && <p className="border-t border-border px-5 py-2 text-xs text-error">{uploadError}</p>}
      {docError && <p className="border-t border-border px-5 py-2 text-xs text-error">{docError}</p>}
    </div>
  );
}
