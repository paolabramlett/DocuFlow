"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const normalizedEmail = email.trim().toLowerCase();
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
      redirectTo: `${window.location.origin}/set-password`,
    });
    setPending(false);

    if (resetError) {
      // Supabase's resetPasswordForEmail already never reveals whether the address exists — an
      // error here is a genuine operational failure (network, rate limit, misconfiguration), not
      // "email not found", so it gets its own distinct message rather than folding into the
      // neutral success text below. Logged internally so a real outage is visible; never shown
      // to the user in a way that could reveal account existence.
      console.error("resetPasswordForEmail failed", { message: resetError.message });
      setError("No pudimos procesar tu solicitud. Inténtalo de nuevo en unos minutos.");
      return;
    }

    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-input bg-royal-600 text-sm font-bold text-white">D</div>
            <span className="text-[15px] font-semibold tracking-tight text-text-primary">DocuFlow</span>
          </div>
        </div>

        <div className="rounded-panel border border-border bg-surface p-7 shadow-md">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Recuperar contraseña</h1>
          <p className="mt-1 text-sm text-text-secondary">Te enviaremos un enlace para elegir una nueva.</p>

          {sent ? (
            <p className="mt-4 text-sm text-text-secondary">
              Si existe una cuenta con este correo, recibirás un enlace para restablecer tu contraseña.
            </p>
          ) : (
            <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Correo electrónico</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
                />
              </label>

              {error && <p className="text-sm text-error">{error}</p>}

              <button
                type="submit"
                disabled={pending}
                className="mt-1 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Enviando…" : "Enviar enlace"}
              </button>
            </form>
          )}

          <p className="mt-5 text-center text-sm">
            <Link href="/login" className="font-medium text-royal-600 hover:text-royal-700">
              Volver a inicio de sesión
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
