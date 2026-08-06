import { LandingHeader } from "./header";
import { Hero } from "./hero";
import { ProblemSolution } from "./problem-solution";
import { Sectors } from "./sectors";
import { HowItWorks } from "./how-it-works";
import { Solutions } from "./solutions";
import { Pricing } from "./pricing";
import { Faq } from "./faq";
import { FinalCta } from "./final-cta";
import { LandingFooter } from "./footer";
import { WhatsAppFloatButton } from "./whatsapp-float";
import { LandingJsonLd } from "./json-ld";

// Public marketing landing page, rendered at `/` for anonymous visitors only (src/app/page.tsx
// redirects any signed-in user straight to /cases before this ever renders). Every section is a
// plain server component — no client-side JS is required for content, only for the native
// <details> FAQ accordion (which needs none either), keeping the page fully readable by search
// crawlers and LLMs doing GEO without waiting on hydration.
export function LandingPage() {
  return (
    <>
      <LandingJsonLd />
      <LandingHeader />
      <main>
        {/* Hero renders the page's single <h1> — keep it that way, don't add a second one here. */}
        <Hero />
        <ProblemSolution />
        <Sectors />
        <HowItWorks />
        <Solutions />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <LandingFooter />
      <WhatsAppFloatButton />
    </>
  );
}
