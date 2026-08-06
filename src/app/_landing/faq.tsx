import { FAQ_ITEMS } from "./faq-data";

// Native <details>/<summary> — accessible and fully indexable without any client-side JS, which
// matters for the GEO goal (an LLM reading the page sees the real question+answer text, not an
// empty shell waiting on hydration).
export function Faq() {
  return (
    <section id="faq" aria-label="Preguntas frecuentes" className="bg-app-bg py-20">
      <div className="mx-auto max-w-3xl px-6 lg:px-8">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
          Preguntas frecuentes
        </h2>
        <dl className="mt-12 space-y-4">
          {FAQ_ITEMS.map((item) => (
            <details
              key={item.question}
              className="group rounded-card border border-border bg-surface p-6 open:shadow-sm"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-text-primary">
                <span>{item.question}</span>
                <ChevronIcon className="h-5 w-5 shrink-0 text-text-secondary transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-4 text-sm text-text-secondary">{item.answer}</p>
            </details>
          ))}
        </dl>
      </div>
    </section>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5.2 7.5a1 1 0 0 1 1.4 0L10 10.9l3.4-3.4a1 1 0 1 1 1.4 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L5.2 8.9a1 1 0 0 1 0-1.4z"
        clipRule="evenodd"
      />
    </svg>
  );
}
