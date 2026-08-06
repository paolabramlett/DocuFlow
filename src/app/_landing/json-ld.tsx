import { FAQ_ITEMS } from "./faq-data";
import { SITE_URL } from "./constants";

// Structured data for GEO (how an LLM parses/cites the page) and traditional SEO rich results.
// Kept as one component so all three graphs ship together and stay easy to audit.
export function LandingJsonLd() {
  const softwareApplication = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Avanza",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    description:
      "Avanza automatiza el seguimiento de expedientes con recordatorios programados que persiguen a los clientes por documentos y requisitos pendientes, para notarías, despachos contables, legales, aseguradoras y recursos humanos.",
    url: SITE_URL,
    offers: [
      {
        "@type": "Offer",
        name: "Starter",
        price: "599",
        priceCurrency: "MXN",
        description: "Hasta 3 usuarios, expedientes y Blueprints ilimitados, portal del cliente.",
      },
      {
        "@type": "Offer",
        name: "Professional",
        price: "1499",
        priceCurrency: "MXN",
        description: "Hasta 10 usuarios, automatizaciones, dashboard de indicadores, reportes.",
        availability: "https://schema.org/PreOrder",
      },
    ],
  };

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEMS.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };

  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Avanza",
    url: SITE_URL,
    logo: `${SITE_URL}/img/Logo-1.png`,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplication) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPage) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organization) }}
      />
    </>
  );
}
