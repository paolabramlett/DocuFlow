import Image from "next/image";

interface Sector {
  readonly name: string;
  readonly description: string;
  readonly image: string;
  readonly alt: string;
}

// Matches the real `organizations.industry` enum (src/application/update-organization.ts) — these
// are the actual sectors the product supports, not a marketing-only list.
const SECTORS: readonly Sector[] = [
  {
    name: "Notarías",
    description:
      "Escrituras, poderes, trámites que dependen de que el cliente entregue identificaciones y comprobantes a tiempo. Avanza persigue cada documento por ti.",
    image: "https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=800&auto=format&fit=crop&q=80",
    alt: "Firma de un documento notarial a mano, con pluma sobre papel",
  },
  {
    name: "Despachos contables",
    description:
      "Facturas, estados de cuenta, comprobantes fiscales que llegan tarde o incompletos cada cierre de mes. Automatiza el recordatorio, no la contabilidad.",
    image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&auto=format&fit=crop&q=80",
    alt: "Documentos fiscales y una calculadora sobre un escritorio",
  },
  {
    name: "Despachos legales",
    description:
      "Cada caso depende de expedientes, contratos y evidencia que el cliente debe aportar. Deja de rastrear correos sueltos y dale seguimiento en un solo lugar.",
    image: "https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=800&auto=format&fit=crop&q=80",
    alt: "Dos personas revisando notas y documentos legales sobre una mesa",
  },
  {
    name: "Aseguradoras",
    description:
      "Pólizas, siniestros y renovaciones que se atoran esperando papeles del asegurado. Los recordatorios automáticos aceleran el cierre de cada caso.",
    image: "https://images.unsplash.com/photo-1521791136064-7986c2920216?w=800&auto=format&fit=crop&q=80",
    alt: "Apretón de manos entre dos profesionales en una oficina",
  },
  {
    name: "Recursos humanos",
    description:
      "Onboarding de personal, documentación laboral, comprobantes de estudios. Da de alta al colaborador una vez y deja que Avanza reúna todo.",
    image: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&auto=format&fit=crop&q=80",
    alt: "Equipo de trabajo colaborando alrededor de una mesa con laptops",
  },
];

export function Sectors() {
  return (
    <section aria-label="Sectores que atendemos" className="bg-app-bg py-20">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-text-primary sm:text-4xl">
            Hecho para negocios que viven de expedientes
          </h2>
          <p className="mt-4 text-lg text-text-secondary">
            Si tu trabajo depende de que un cliente te entregue documentos a tiempo, Avanza fue
            diseñado para ti.
          </p>
        </div>
        <div className="mt-14 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {SECTORS.map((sector) => (
            <article
              key={sector.name}
              className="overflow-hidden rounded-panel border border-border bg-surface shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="relative h-48 w-full">
                <Image
                  src={sector.image}
                  alt={sector.alt}
                  fill
                  sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  className="object-cover"
                />
              </div>
              <div className="p-6">
                <h3 className="text-lg font-semibold text-text-primary">{sector.name}</h3>
                <p className="mt-2 text-sm text-text-secondary">{sector.description}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
