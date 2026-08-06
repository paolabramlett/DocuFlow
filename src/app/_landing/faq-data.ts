// Shared between the rendered FAQ accordion (faq.tsx) and the FAQPage JSON-LD (json-ld.tsx) so
// the two never drift out of sync.
export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "¿Cómo hace Avanza para dejar de perseguir a mis clientes?",
    answer:
      "Cuando das de alta a un cliente contra un Blueprint, Avanza programa recordatorios automáticos por los documentos o requisitos que aún faltan. Tú no tienes que acordarte de escribirle — el sistema lo hace por ti, hasta que el expediente queda completo.",
  },
  {
    question: "¿Qué sectores puede usar Avanza?",
    answer:
      "Notarías, despachos contables, despachos legales, aseguradoras y recursos humanos son los sectores que soportamos hoy — cualquier negocio que dependa de reunir documentos de un cliente para avanzar un expediente.",
  },
  {
    question: "¿Necesito tarjeta de crédito para probar Avanza?",
    answer: "No. Puedes crear tu cuenta y tu primera plantilla sin ingresar ningún método de pago.",
  },
  {
    question: "¿Qué es un Blueprint?",
    answer:
      "Es la plantilla que define, una sola vez, qué requisitos y documentos necesita un tipo de expediente. Cada cliente nuevo arranca con esa checklist ya lista, sin armarla desde cero.",
  },
  {
    question: "¿Mis clientes necesitan crear una cuenta?",
    answer:
      "No. Cada cliente recibe una invitación a su Portal, donde ve qué le falta y sube sus documentos directamente — sin contraseñas que recordar.",
  },
  {
    question: "¿Puedo migrar mis expedientes actuales?",
    answer:
      "Sí. Nuestro equipo te ayuda a dar de alta tus expedientes en curso durante la puesta en marcha, sin perder el historial de lo que ya has avanzado.",
  },
  {
    question: "¿Qué tan seguros están los documentos que suben mis clientes?",
    answer:
      "Cada organización tiene sus datos aislados y cada documento queda ligado únicamente al expediente y al cliente que lo subió, con control de acceso por rol dentro de tu equipo.",
  },
  {
    question: "¿Puedo cancelar cuando quiera?",
    answer:
      "Sí, no hay permanencia forzosa. Escríbenos por WhatsApp o por correo y damos de baja tu cuenta.",
  },
] as const;
