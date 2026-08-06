import Image from "next/image";
import Link from "next/link";
import { WhatsAppLink } from "./whatsapp-link";
import { WHATSAPP_MESSAGES } from "./constants";

export function FinalCta() {
  return (
    <section aria-label="Empieza con Avanza" className="relative overflow-hidden bg-royal-700 py-20">
      <div className="absolute inset-0 opacity-15">
        <Image
          src="https://images.unsplash.com/photo-1568992687947-868a62a9f521?w=1600&auto=format&fit=crop&q=80"
          alt=""
          fill
          className="object-cover"
        />
      </div>
      <div className="relative mx-auto max-w-3xl px-6 text-center lg:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Deja que Avanza persiga los documentos. Tú solo revisa.
        </h2>
        <p className="mt-4 text-lg text-royal-100">
          Da de alta tu primera plantilla hoy y deja de perder tiempo detrás de tus clientes.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <Link
            href="/signup"
            className="inline-flex items-center justify-center rounded-input bg-white px-6 py-3 text-base font-medium text-royal-700 shadow-md transition-colors hover:bg-royal-50"
          >
            Empieza gratis
          </Link>
          <WhatsAppLink
            message={WHATSAPP_MESSAGES.finalCta}
            className="inline-flex items-center justify-center rounded-input border border-white/40 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-white/10"
          >
            Escríbenos por WhatsApp
          </WhatsAppLink>
        </div>
      </div>
    </section>
  );
}
