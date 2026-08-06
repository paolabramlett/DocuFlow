import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { LandingPage } from "./_landing/landing-page";
import { SITE_URL } from "./_landing/constants";

// The public marketing entry point. Signed-in visitors (staff or a Portal client alike) go
// straight to their workspace exactly as before — /cases's own requireStaff() sorts out
// staff-vs-mid-onboarding-vs-client from there, unchanged. Only a genuinely anonymous visitor now
// sees the landing page instead of bouncing through a redirect to a page that would just bounce
// them again.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Avanza — Deja de perseguir documentos a tus clientes",
  description:
    "Avanza automatiza el seguimiento de expedientes: recordatorios programados que persiguen a tus clientes por ti. Da de alta con una plantilla y solo entra a revisar cuando todo esté listo. Para notarías, despachos contables, legales, aseguradoras y RH.",
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "/" },
  openGraph: {
    title: "Avanza — Deja de perseguir documentos a tus clientes",
    description:
      "Recordatorios automáticos que persiguen a tus clientes por ti. Da de alta con una plantilla y solo revisa cuando todo esté en orden.",
    url: SITE_URL,
    siteName: "Avanza",
    locale: "es_MX",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Avanza — Deja de perseguir documentos a tus clientes",
    description:
      "Recordatorios automáticos que persiguen a tus clientes por ti. Da de alta con una plantilla y solo revisa cuando todo esté en orden.",
  },
};

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/cases");
  }

  return <LandingPage />;
}
