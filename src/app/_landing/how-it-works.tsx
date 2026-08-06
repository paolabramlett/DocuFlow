const STEPS = [
  {
    number: "1",
    title: "Crea tu Blueprint una vez",
    description:
      "Define la plantilla de requisitos para ese tipo de expediente — documentos, etapas, quién participa. La reutilizas en cada cliente nuevo.",
  },
  {
    number: "2",
    title: "Da de alta al cliente y despreocúpate",
    description:
      "Invitas al cliente a su Portal. A partir de ahí, Avanza le manda los recordatorios programados — tú no vuelves a escribirle para pedirle un documento.",
  },
  {
    number: "3",
    title: "Entra solo a revisar",
    description:
      "Cuando el cliente sube lo que falta, tú lo ves llegar. Tu trabajo deja de ser perseguir y vuelve a ser revisar que todo esté en orden.",
  },
] as const;

export function HowItWorks() {
  return (
    <section aria-label="Cómo funciona Avanza" className="bg-surface py-20">
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
            Tres pasos. Cero persecución.
          </h2>
        </div>
        <ol className="mt-14 grid grid-cols-1 gap-10 sm:grid-cols-3">
          {STEPS.map((step) => (
            <li key={step.number} className="text-center">
              <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-royal-600 text-lg font-semibold text-white">
                {step.number}
              </span>
              <h3 className="mt-5 text-lg font-semibold text-text-primary">{step.title}</h3>
              <p className="mt-2 text-sm text-text-secondary">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
