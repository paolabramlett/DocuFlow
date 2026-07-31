"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { completeOnboardingAction } from "./actions";
import { MIN_PASSWORD_LENGTH } from "@/features/auth/password";

const INDUSTRY_LABEL: Record<string, string> = {
  notary: "Notaría",
  accounting: "Contaduría",
  legal: "Legal",
  insurance: "Seguros",
  hr: "Recursos humanos",
  other: "Otro",
};

export function OnboardingForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [organizationIndustry, setOrganizationIndustry] = useState("notary");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result = await completeOnboardingAction({
        password,
        passwordConfirmation,
        organizationName,
        organizationIndustry,
      });

      if (result.ok) {
        router.replace("/cases");
        router.refresh();
      } else {
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app-bg px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/img/Logo-1.png" alt="Avanza" className="h-6 w-auto" />
        </div>

        <form onSubmit={onSubmit} className="rounded-panel border border-border bg-surface p-7 shadow-md">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Completa tu cuenta</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Elige tu contraseña y cuéntanos de tu organización.
          </p>

          <label className="mt-6 block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Contraseña</span>
            <div className="flex gap-2">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                required
                className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="shrink-0 rounded-input border border-border px-3 text-xs font-medium text-text-secondary hover:bg-app-bg"
              >
                {showPassword ? "Ocultar" : "Mostrar"}
              </button>
            </div>
          </label>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Confirmar contraseña</span>
            <input
              type={showPassword ? "text" : "password"}
              value={passwordConfirmation}
              onChange={(e) => setPasswordConfirmation(e.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              required
              className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            />
          </label>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Nombre de la organización</span>
            <input
              type="text"
              value={organizationName}
              onChange={(e) => setOrganizationName(e.target.value)}
              required
              className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            />
          </label>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">Industria</span>
            <select
              value={organizationIndustry}
              onChange={(e) => setOrganizationIndustry(e.target.value)}
              className="w-full rounded-input border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:ring-2 focus:ring-royal-100"
            >
              {Object.entries(INDUSTRY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>

          {error && <p className="mt-3 text-sm text-error">{error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="mt-6 w-full rounded-input bg-royal-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
          >
            {pending ? "Creando…" : "Crear organización"}
          </button>
        </form>
      </div>
    </div>
  );
}
