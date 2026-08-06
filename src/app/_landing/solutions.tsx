import Image from "next/image";

interface Solution {
  readonly title: string;
  readonly description: string;
  readonly image: string;
  readonly alt: string;
  readonly highlight?: boolean;
}

const SOLUTIONS: readonly Solution[] = [
  {
    title: "Recordatorios automáticos",
    description:
      "El corazón de Avanza. En lugar de que tú o tu equipo tengan que acordarse de escribirle a cada cliente, Avanza programa y envía los recordatorios solo — hasta que el documento llega. Es la persecución que ya no tienes que hacer tú.",
    image: "https://images.unsplash.com/photo-1495364141860-b0d03eccd065?w=1000&auto=format&fit=crop&q=80",
    alt: "Una mano sosteniendo un despertador, representando un recordatorio programado",
    highlight: true,
  },
  {
    title: "Blueprints reutilizables",
    description:
      "Define una vez la plantilla de requisitos por tipo de expediente. Cada cliente nuevo arranca con la checklist correcta desde el primer día, sin armarla de nuevo.",
    image: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=1000&auto=format&fit=crop&q=80",
    alt: "Varias personas trabajando en laptops alrededor de una mesa, organizando información",
  },
  {
    title: "Portal del cliente",
    description:
      "Tu cliente entra a un solo lugar para ver qué le falta y subir sus documentos — desde el teléfono, sin cuentas complicadas ni cadenas de correos perdidos.",
    image: "https://images.unsplash.com/photo-1520333789090-1afc82db536a?w=1000&auto=format&fit=crop&q=80",
    alt: "Una persona revisando su portal de cliente desde el celular junto a su laptop",
  },
  {
    title: "Gestión documental con progreso real",
    description:
      "Cada archivo se sube con barra de progreso real y se puede cancelar a medio camino — nada de pantallas congeladas preguntándose si sí se subió el documento.",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1000&auto=format&fit=crop&q=80",
    alt: "Una mano señalando la pantalla de una laptop mientras se revisa un documento",
  },
  {
    title: "Firma de cumplimiento",
    description:
      "Cuando el expediente queda completo, se cierra con una firma que deja constancia — trazabilidad real de que todo se revisó y se entregó en orden.",
    image: "https://images.unsplash.com/photo-1521791055366-0d553872125f?w=1000&auto=format&fit=crop&q=80",
    alt: "Una mano firmando un documento en papel con pluma",
  },
];

export function Solutions() {
  return (
    <section aria-label="Soluciones de Avanza" className="bg-app-bg py-20">
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
            Todo lo que necesitas para dejar de perseguir y solo revisar
          </h2>
        </div>
        <div className="mt-16 space-y-16">
          {SOLUTIONS.map((solution, i) => (
            <div
              key={solution.title}
              className={`grid grid-cols-1 items-center gap-10 lg:grid-cols-2 ${
                i % 2 === 1 ? "lg:[&>*:first-child]:order-2" : ""
              }`}
            >
              <div className="overflow-hidden rounded-panel shadow-md">
                <Image
                  src={solution.image}
                  alt={solution.alt}
                  width={1000}
                  height={700}
                  className="h-72 w-full object-cover sm:h-80"
                />
              </div>
              <div>
                {solution.highlight && (
                  <p className="mb-3 inline-flex items-center rounded-full bg-royal-100 px-3 py-1 text-sm font-medium text-royal-700">
                    Lo que hace la diferencia
                  </p>
                )}
                <h3 className="text-2xl font-semibold text-text-primary">{solution.title}</h3>
                <p className="mt-3 text-base text-text-secondary">{solution.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
