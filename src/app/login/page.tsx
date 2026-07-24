"use client";

/*
 * Staff sign-in. Email + password via Supabase Auth. The browser client sets the session cookie
 * that Server Components and the proxy then read. Clients never come through here — they arrive
 * via an invitation and verify with a one-time code (see /portal).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      setError("Correo o contraseña incorrectos.");
      setPending(false);
      return;
    }
    router.push("/cases");
    router.refresh();
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

        <form onSubmit={onSubmit} className="rounded-panel border border-border bg-surface p-7 shadow-md">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Inicia sesión</h1>
          <p className="mt-1 text-sm text-text-secondary">Accede al espacio de trabajo de tu notaría.</p>

          <label className="mt-6 block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Correo electrónico</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            />
          </label>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Contraseña</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            />
          </label>

          {error && <p className="mt-3 text-sm text-error">{error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="mt-6 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
          >
            {pending ? "Entrando…" : "Iniciar sesión"}
          </button>
        </form>

        <p className="mt-5 text-center font-mono text-xs text-text-secondary/70">
          Demo: staff@docuflow.mx / docuflow-demo-2026
        </p>
      </div>
    </div>
  );
}
