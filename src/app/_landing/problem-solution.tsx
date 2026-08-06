export function ProblemSolution() {
  return (
    <section aria-label="El problema y cómo lo resolvemos" className="bg-surface py-20">
      <div className="mx-auto max-w-5xl px-6 lg:px-8">
        <h2 className="text-center text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
          El verdadero cuello de botella no es el trabajo. Es esperar al cliente.
        </h2>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="rounded-panel border border-border bg-app-bg p-8">
            <p className="mb-3 text-sm font-semibold tracking-wide text-error uppercase">
              Sin Avanza
            </p>
            <p className="text-lg text-text-primary">
              Le escribes al cliente. No responde. Le vuelves a escribir por WhatsApp. Le llamas.
              Recibes el documento equivocado. Empiezas de nuevo. El expediente se queda parado —
              no porque falte trabajo tuyo, sino porque nadie está{" "}
              <span className="font-semibold">dando seguimiento sistemático</span>.
            </p>
          </div>
          <div className="rounded-panel border border-royal-100 bg-royal-50 p-8">
            <p className="mb-3 text-sm font-semibold tracking-wide text-royal-700 uppercase">
              Con Avanza
            </p>
            <p className="text-lg text-text-primary">
              Das de alta al cliente con la plantilla del expediente. Avanza le manda los
              recordatorios — programados, automáticos, sin que tú tengas que acordarte. Tu única
              tarea vuelve a ser la que realmente importa:{" "}
              <span className="font-semibold">revisar que todo esté en orden</span>.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
