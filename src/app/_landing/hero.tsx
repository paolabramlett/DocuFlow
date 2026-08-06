import Image from "next/image";
import Link from "next/link";
import { WhatsAppLink } from "./whatsapp-link";
import { WhatsAppIcon } from "./whatsapp-icon";
import { WHATSAPP_MESSAGES } from "./constants";

export function Hero() {
  return (
    <section aria-label="Introducción a Avanza" className="relative overflow-hidden bg-app-bg">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-6 py-20 sm:py-28 lg:grid-cols-2 lg:px-8">
        <div>
          <p className="mb-4 inline-flex items-center rounded-full bg-royal-50 px-3 py-1 text-sm font-medium text-royal-700">
            Para notarías, despachos contables, legales, aseguradoras y RH
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-text-primary sm:text-5xl">
            Deja de perseguir a tus clientes por sus documentos
          </h1>
          <p className="mt-6 text-lg text-text-secondary">
            En la mayoría de los despachos, el tiempo no se va en el trabajo — se va en recordarle
            al cliente, otra vez, que falta un documento. <strong className="text-text-primary">Avanza
            hace esa persecución por ti</strong>: recordatorios programados que llegan solos hasta
            que el expediente está completo. Tú solo das de alta al cliente con una plantilla y
            entras a revisar cuando todo esté en orden.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center rounded-input bg-royal-600 px-6 py-3 text-base font-medium text-white shadow-md transition-colors hover:bg-royal-700"
            >
              Empieza gratis
            </Link>
            <WhatsAppLink
              message={WHATSAPP_MESSAGES.hero}
              className="inline-flex items-center justify-center gap-2 rounded-input border border-border bg-surface px-6 py-3 text-base font-medium text-text-primary shadow-sm transition-colors hover:bg-royal-50"
            >
              <WhatsAppIcon className="h-5 w-5 text-[#25D366]" />
              Escríbenos por WhatsApp
            </WhatsAppLink>
          </div>
          <p className="mt-4 text-sm text-text-secondary">
            Sin tarjeta de crédito. Configura tu primera plantilla en minutos.
          </p>
        </div>
        <div className="relative">
          <div className="overflow-hidden rounded-panel shadow-lg">
            <Image
              src="https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=1200&auto=format&fit=crop&q=80"
              alt="Un equipo de despacho celebrando que un expediente quedó completo, sin más pendientes que perseguir"
              width={1200}
              height={900}
              className="h-full w-full object-cover"
              priority
            />
          </div>
        </div>
      </div>
    </section>
  );
}
