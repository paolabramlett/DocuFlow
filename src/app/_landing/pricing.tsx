import Link from "next/link";

interface Plan {
  readonly name: string;
  readonly price: string;
  readonly tagline: string;
  readonly features: readonly string[];
  readonly comingSoon?: boolean;
  readonly extendsPlan?: string;
}

const PLANS: readonly Plan[] = [
  {
    name: "Starter",
    price: "$599 MXN / mes",
    tagline: "Ideal para despachos pequeños y profesionales independientes.",
    features: [
      "Hasta 3 usuarios",
      "Expedientes ilimitados",
      "Blueprints ilimitados",
      "Portal del cliente",
      "Gestión documental",
      "Seguimiento de tareas",
      "Firma de cumplimiento",
      "Soporte por email",
    ],
  },
  {
    name: "Professional",
    price: "$1,499 MXN / mes",
    tagline: "Para equipos que ya trabajan de forma colaborativa.",
    comingSoon: true,
    extendsPlan: "Todo lo de Starter más:",
    features: [
      "Hasta 10 usuarios",
      "Automatizaciones",
      "Dashboard de indicadores",
      "Reportes",
      "Historial de auditoría",
      "Roles y permisos avanzados",
      "Prioridad en soporte",
    ],
  },
];

export function Pricing() {
  return (
    <section id="precios" aria-label="Planes y precios" className="bg-surface py-20">
      <div className="mx-auto max-w-5xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
            Planes simples, sin sorpresas
          </h2>
          <p className="mt-4 text-lg text-text-secondary">
            Empieza con Starter y crece cuando lo necesites.
          </p>
        </div>
        <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-2">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`relative rounded-panel border p-8 ${
                plan.comingSoon
                  ? "border-border bg-app-bg opacity-90"
                  : "border-royal-600 bg-surface shadow-lg"
              }`}
            >
              {plan.comingSoon && (
                <span className="absolute right-6 top-6 rounded-full bg-neutral-bg px-3 py-1 text-xs font-semibold text-text-secondary">
                  Pronto
                </span>
              )}
              <h3 className="text-xl font-semibold text-text-primary">{plan.name}</h3>
              <p className="mt-2 text-3xl font-semibold text-text-primary">{plan.price}</p>
              <p className="mt-2 text-sm text-text-secondary">{plan.tagline}</p>
              {plan.extendsPlan && (
                <p className="mt-5 text-sm font-medium text-text-primary">{plan.extendsPlan}</p>
              )}
              <ul className={plan.extendsPlan ? "mt-3 space-y-3" : "mt-6 space-y-3"}>
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary">
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-royal-600" />
                    {feature}
                  </li>
                ))}
              </ul>
              {plan.comingSoon ? (
                <button
                  type="button"
                  disabled
                  className="mt-8 w-full cursor-not-allowed rounded-input border border-border bg-neutral-bg px-6 py-3 text-center text-sm font-medium text-text-secondary"
                >
                  Disponible pronto
                </button>
              ) : (
                <Link
                  href="/signup"
                  className="mt-8 block w-full rounded-input bg-royal-600 px-6 py-3 text-center text-sm font-medium text-white shadow-md transition-colors hover:bg-royal-700"
                >
                  Empieza con Starter
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0l-3.5-3.5a1 1 0 1 1 1.4-1.4l2.8 2.8 6.8-6.8a1 1 0 0 1 1.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}
