"use client";

import { useState } from "react";
import Link from "next/link";
import { signUpAction } from "./actions";

export default function SignUpPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);

  function isValidFormat(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormatError(null);

    if (!isValidFormat(email)) {
      setFormatError("Revisa el formato del correo.");
      return;
    }

    setPending(true);
    await signUpAction(email);
    setPending(false);
    setSent(true); // always neutral — signUpAction never distinguishes outcomes
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/img/Logo-1.png" alt="Avanza" className="h-6 w-auto" />
        </div>

        <div className="rounded-panel border border-border bg-surface p-7 shadow-md">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Crea tu cuenta</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Te enviaremos un enlace para confirmar tu correo y continuar.
          </p>

          {sent ? (
            <p className="mt-4 text-sm text-text-secondary">
              Si el correo es válido, te enviamos un enlace para continuar.
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

              {formatError && <p className="text-sm text-error">{formatError}</p>}

              <button
                type="submit"
                disabled={pending}
                className="mt-1 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Enviando…" : "Crear cuenta"}
              </button>
            </form>
          )}

          <p className="mt-5 text-center text-sm">
            <Link href="/login" className="font-medium text-royal-600 hover:text-royal-700">
              Ya tengo una cuenta
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
