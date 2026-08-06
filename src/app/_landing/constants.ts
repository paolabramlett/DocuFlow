// Shared constants for the marketing landing page. Kept in one place so the WhatsApp number and
// site URL are never hand-typed twice and drifting.

export const SITE_URL = "https://avanza.work";

// Mexican mobile number, wa.me format (no leading +, no spaces/dashes: 52 + area code + number).
export const WHATSAPP_NUMBER = "529514082852";

export function buildWhatsAppUrl(message: string): string {
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

export const WHATSAPP_MESSAGES = {
  hero: "Hola, quiero saber más sobre Avanza para dejar de perseguir documentos de mis clientes.",
  floating: "Hola, tengo una pregunta sobre Avanza.",
  finalCta: "Hola, quiero empezar a usar Avanza en mi despacho.",
} as const;
