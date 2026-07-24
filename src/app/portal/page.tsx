"use client";

/*
 * DocuFlow — Client portal.
 *
 * The client side of the flow: a participant arrives from an invitation, verifies with an email
 * code, and sees ONLY their own assigned requirements — upload, feedback, and re-upload. No
 * sidebar, focused and mobile-first (clients are usually on a phone). See DESIGN.md.
 *
 * This page walks the whole flow with synthetic data: invitation → OTP → documents. Upload and
 * verification are simulated for the demo; the real wiring lives in the case-access feature.
 */

import { useRef, useState } from "react";
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

// ---------- Invited context (what the link reveals before verifying: org + case only) ----------
const INVITE = {
  org: "Notaría Central",
  caseTitle: "Compraventa · Restrepo",
  role: "Comprador",
  maskedEmail: "p•••••@•••••.com",
};

// ---------- Requirement state ----------
type ReqState = "pending" | "review" | "approved" | "rejected";
const META: Record<ReqState, { label: string; fg: string; bg: string; Icon: (p: IconProps) => React.ReactElement }> = {
  pending: { label: "Pendiente", fg: "text-warning", bg: "bg-warning-bg", Icon: IconClock },
  review: { label: "En revisión", fg: "text-review", bg: "bg-review-bg", Icon: IconEye },
  approved: { label: "Aprobado", fg: "text-success", bg: "bg-success-bg", Icon: IconCheck },
  rejected: { label: "Rechazado", fg: "text-error", bg: "bg-error-bg", Icon: IconX },
};

type Req = { id: string; label: string; hint?: string; state: ReqState; fileName?: string; comment?: string };

const INITIAL: Req[] = [
  { id: "R-01", label: "INE", hint: "Frente y reverso, legible.", state: "approved", fileName: "ine-paola.pdf" },
  { id: "R-02", label: "CURP", hint: "Documento oficial actualizado.", state: "approved", fileName: "curp.pdf" },
  {
    id: "R-03", label: "RFC", hint: "Constancia con cédula de identificación fiscal.",
    state: "rejected", fileName: "rfc-viejo.pdf",
    comment: "El documento está incompleto: falta la segunda página. Vuelve a subirlo completo.",
  },
  { id: "R-04", label: "Comprobante de domicilio", hint: "No mayor a 3 meses (luz, agua o predial).", state: "pending" },
];

export default function ClientPortalPage() {
  const [phase, setPhase] = useState<"landing" | "otp" | "portal">("landing");

  return (
    <div className="min-h-screen bg-app-bg">
      {phase === "landing" && <Landing onContinue={() => setPhase("otp")} />}
      {phase === "otp" && <Otp onVerify={() => setPhase("portal")} onBack={() => setPhase("landing")} />}
      {phase === "portal" && <Portal />}
    </div>
  );
}

// ---------- Brand mark ----------
function Brand({ light }: { light?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`flex size-8 items-center justify-center rounded-input text-sm font-bold ${light ? "bg-white/15 text-white" : "bg-royal-600 text-white"}`}>D</div>
      <span className={`text-[15px] font-semibold tracking-tight ${light ? "text-white" : "text-text-primary"}`}>DocuFlow</span>
    </div>
  );
}

// ---------- 1 · Invitation landing ----------
function Landing({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center"><Brand /></div>
        <div className="rounded-panel border border-border bg-surface p-7 shadow-md sm:p-8">
          <div className="text-sm font-medium text-royal-600">{INVITE.org}</div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-primary">
            Te invitaron a completar tu expediente
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Se trata del expediente <span className="font-medium text-text-primary">{INVITE.caseTitle}</span>. Solo tendrás que subir algunos documentos — sin crear cuenta.
          </p>

          <div className="mt-5 flex items-start gap-3 rounded-card bg-royal-50 px-4 py-3">
            <IconShield className="mt-0.5 size-5 shrink-0 text-royal-600" />
            <p className="text-sm text-text-secondary">
              Para proteger tu información, te enviaremos un <span className="font-medium text-text-primary">código de acceso</span> a tu correo. Solo tú, con acceso a ese correo, puedes abrir el expediente.
            </p>
          </div>

          <button
            onClick={onContinue}
            className="mt-6 w-full rounded-input bg-royal-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-royal-700"
          >
            Enviar código de acceso
          </button>
        </div>
        <p className="mt-5 text-center text-xs text-text-secondary">
          ¿No esperabas esta invitación? Puedes ignorar este mensaje sin problema.
        </p>
      </div>
    </div>
  );
}

// ---------- 2 · OTP ----------
function Otp({ onVerify, onBack }: { onVerify: () => void; onBack: () => void }) {
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [error, setError] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const code = digits.join("");

  function setDigit(i: number, v: string) {
    const clean = v.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[i] = clean;
    setDigits(next);
    setError(false);
    if (clean && i < 5) refs.current[i + 1]?.focus();
  }

  function onKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  }

  function verify() {
    if (code.length === 6) onVerify();
    else setError(true);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center"><Brand /></div>
        <div className="rounded-panel border border-border bg-surface p-7 shadow-md sm:p-8">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Ingresa tu código</h1>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            Enviamos un código de 6 dígitos a <span className="font-medium text-text-primary tabular">{INVITE.maskedEmail}</span>. Vence en 5 minutos.
          </p>

          <div className="mt-6 flex justify-between gap-2" onPaste={(e) => {
            const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
            if (text) { e.preventDefault(); setDigits(text.padEnd(6, "").split("").slice(0, 6).map((c) => c || "")); }
          }}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { refs.current[i] = el; }}
                value={d}
                inputMode="numeric"
                maxLength={1}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => onKey(i, e)}
                className={`h-14 w-full rounded-input border bg-surface text-center text-xl font-semibold text-text-primary tabular outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100 ${error ? "border-error" : "border-border"}`}
              />
            ))}
          </div>
          {error && <p className="mt-2 text-xs text-error">Ingresa los 6 dígitos del código.</p>}

          <button onClick={verify} className="mt-6 w-full rounded-input bg-royal-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
            Verificar y continuar
          </button>

          <div className="mt-4 flex items-center justify-between text-sm">
            <button onClick={onBack} className="font-medium text-text-secondary transition-colors hover:text-text-primary">Atrás</button>
            <button className="font-medium text-royal-600 transition-colors hover:text-royal-700">Reenviar código</button>
          </div>
          <p className="mt-4 text-center text-xs text-text-secondary">Demo: ingresa cualquier código de 6 dígitos.</p>
        </div>
      </div>
    </div>
  );
}

// ---------- 3 · The portal ----------
function Portal() {
  const [reqs, setReqs] = useState<Req[]>(INITIAL);
  const approved = reqs.filter((r) => r.state === "approved").length;
  const total = reqs.length;
  const pct = Math.round((approved / total) * 100);
  const done = approved === total;

  function upload(id: string, fileName: string) {
    setReqs((rs) => rs.map((r) => (r.id === id ? { ...r, state: "review", fileName, comment: undefined } : r)));
  }

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-5">
          <Brand />
          <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <IconShield className="size-4 text-success" /> Sesión segura
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-7">
        {/* Case header + progress */}
        <div className="text-sm font-medium text-royal-600">{INVITE.org}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text-primary">{INVITE.caseTitle}</h1>
        <p className="mt-1 text-sm text-text-secondary">Tu rol: {INVITE.role}</p>

        <div className="mt-5 rounded-card border border-border bg-surface p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">Tu progreso</span>
            {done ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
                <IconCheck className="size-3.5" /> Todo enviado
              </span>
            ) : (
              <span className="text-sm font-semibold text-text-primary tabular">{approved} de {total}</span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-app-bg">
              <div className="h-full rounded-full bg-royal-500 transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
            </div>
            {done && (
              <span className="flex size-5 items-center justify-center rounded-full bg-success text-white">
                <IconCheck className="size-3" />
              </span>
            )}
          </div>
        </div>

        {done && (
          <div className="complete-rise mt-5 rounded-card border border-success/20 bg-success-bg/60 p-5 text-center">
            <div className="complete-check mx-auto flex size-12 items-center justify-center rounded-full bg-success text-white">
              <IconCheck className="size-6" />
            </div>
            <h2 className="mt-3 text-lg font-semibold text-text-primary">¡Enviaste todo!</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm text-text-secondary">
              La notaría revisará tus documentos y continuará con tu expediente. Te avisaremos si necesitan algo más.
            </p>
          </div>
        )}

        {/* Requirements */}
        <h2 className="mb-3 mt-8 text-sm font-semibold text-text-primary">Tus documentos</h2>
        <div className="space-y-3">
          {reqs.map((r) => <RequirementCard key={r.id} req={r} onUpload={(name) => upload(r.id, name)} />)}
        </div>

        <p className="mt-8 text-center font-mono text-xs text-text-secondary/60">Datos de demostración sintéticos · Portal del cliente</p>
      </main>
    </div>
  );
}

function RequirementCard({ req, onUpload }: { req: Req; onUpload: (fileName: string) => void }) {
  const m = META[req.state];
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pick = () => fileRef.current?.click();

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <input
        ref={fileRef}
        type="file"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f.name); e.target.value = ""; }}
      />
      <div className="flex items-start gap-3 px-5 py-4">
        <span className={`mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-input ${m.bg} ${m.fg}`}>
          <IconDocument className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-text-primary">{req.label}</span>
            <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${m.fg} ${m.bg}`}>
              <m.Icon className="size-3.5" /> {m.label}
            </span>
          </div>
          {req.hint && req.state === "pending" && <p className="mt-1 text-sm text-text-secondary">{req.hint}</p>}
          {req.fileName && req.state !== "pending" && (
            <p className="mt-1 truncate text-sm text-text-secondary tabular">{req.fileName}</p>
          )}
        </div>
      </div>

      {/* Rejection feedback + re-upload */}
      {req.state === "rejected" && (
        <div className="border-t border-border bg-error-bg/50 px-5 py-3.5">
          <p className="text-sm text-text-primary"><span className="font-semibold text-error">Motivo del rechazo:</span> {req.comment}</p>
          <button onClick={pick} className="mt-3 inline-flex items-center gap-2 rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700">
            <IconRefresh className="size-4" /> Subir nuevo documento
          </button>
        </div>
      )}

      {/* Pending upload */}
      {req.state === "pending" && (
        <div className="border-t border-border px-5 py-4">
          <button onClick={pick} className="flex w-full items-center justify-center gap-2 rounded-input border border-dashed border-royal-100 bg-royal-50/50 py-3 text-sm font-semibold text-royal-600 transition-colors hover:bg-royal-50">
            <IconUpload className="size-4" /> Subir documento
          </button>
        </div>
      )}

      {/* In review — reassurance */}
      {req.state === "review" && (
        <div className="border-t border-border px-5 py-3 text-sm text-text-secondary">
          Recibido. La notaría lo revisará y te avisaremos.
        </div>
      )}
    </div>
  );
}
