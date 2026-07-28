"use client";

/*
 * Shared landing for two entry points: clicking an invite email's link, or a "forgot password"
 * recovery email's link. Both resolve to an authenticated session once Supabase processes the
 * URL — the invite link as an ordinary SIGNED_IN, the recovery link with a dedicated
 * PASSWORD_RECOVERY event. This page deliberately does not try to tell the two apart: any
 * authenticated session may set a new password here, an accepted, explicit product decision
 * (see docs/superpowers/specs/2026-07-28-invite-member-design.md).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { MIN_PASSWORD_LENGTH, passwordsAreValid } from "@/features/auth/password";

type LinkState = "resolving" | "valid" | "invalid";

const RESOLUTION_TIMEOUT_MS = 5000;

export default function SetPasswordPage() {
  const router = useRouter();
  const [linkState, setLinkState] = useState<LinkState>("resolving");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolvedRef = useRef(false);

  useEffect(() => {
    const supabase = createClient();
    const timeoutRef: { current: ReturnType<typeof setTimeout> | undefined } = { current: undefined };
    let cancelled = false;

    function resolve(next: LinkState) {
      if (resolvedRef.current || cancelled) return;
      resolvedRef.current = true;
      clearTimeout(timeoutRef.current);
      setLinkState(next);
    }

    // Two conclusive signals decide this — an authenticated user, or an explicit auth error.
    // The timeout below is a last-resort fallback only, never the primary way this is decided:
    // slow hydration or a slow connection must not be misread as an invalid link.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === "SIGNED_IN" || event === "PASSWORD_RECOVERY" || event === "INITIAL_SESSION") && session?.user) {
        resolve("valid");
      }
    });

    supabase.auth.getUser().then(({ data, error: getUserError }) => {
      if (data.user) {
        resolve("valid");
      } else if (getUserError) {
        resolve("invalid");
      }
    });

    timeoutRef.current = setTimeout(() => resolve("invalid"), RESOLUTION_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutRef.current);
      subscription.unsubscribe();
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!passwordsAreValid(password, confirmation)) {
      setError(`Las contraseñas deben coincidir y tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }

    setPending(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setPending(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setSaved(true);
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

        <div className="rounded-panel border border-border bg-surface p-7 shadow-md">
          {linkState === "resolving" && (
            <p className="text-sm text-text-secondary">Validando enlace…</p>
          )}

          {linkState === "invalid" && (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-text-primary">Enlace vencido o inválido</h1>
              <p className="mt-2 text-sm text-text-secondary">
                Pide un enlace nuevo e inténtalo de nuevo.
              </p>
            </>
          )}

          {linkState === "valid" && !saved && (
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <h1 className="text-xl font-semibold tracking-tight text-text-primary">Establece tu contraseña</h1>

              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Nueva contraseña</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  required
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-text-primary">Confirmar contraseña</span>
                <input
                  type="password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  required
                  className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
                />
              </label>

              {error && <p className="text-sm text-error">{error}</p>}

              <button
                type="submit"
                disabled={pending}
                className="mt-2 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Guardar contraseña"}
              </button>
            </form>
          )}

          {saved && <p className="text-sm text-success">Contraseña guardada. Entrando…</p>}
        </div>
      </div>
    </div>
  );
}
