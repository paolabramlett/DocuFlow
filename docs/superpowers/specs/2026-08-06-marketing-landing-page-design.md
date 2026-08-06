# Marketing Landing Page — Design Spec

**Goal:** Give Avanza a public marketing landing page at `/` with strong SEO/GEO, a Pricing
section, an FAQ, and a WhatsApp CTA — replacing the current unconditional `redirect("/cases")`.

## Core message (drives all copy)

The central pain point: businesses that manage *expedientes* (notarías, despachos contables,
legales, aseguradoras, RH) lose time and momentum **chasing clients** to hand over documents or
meet requirements. Avanza does that chasing *for* them — scheduled, automatic reminders — so the
business only has to (1) register the client against a Blueprint/plantilla and (2) come back later
to review that everything is in order. Every major copy block (Hero, "Cómo funciona", Soluciones)
restates this in different words; it is the product's actual differentiator, not a generic
"digitalize your documents" pitch.

## Routing

`src/app/page.tsx` changes from an unconditional `redirect("/cases")` to: check for an active
session server-side; if authenticated, redirect to `/cases` (unchanged behavior for logged-in
users); if not, render the new `LandingPage` component. No other route changes.

## Sections (single scrolling page)

1. **Hero** — headline built around the chasing-clients pain point, subhead, primary CTA
   ("Empieza gratis" → `/signup`), secondary CTA (WhatsApp).
2. **El problema → la solución** — a short before/after: "Antes: perseguir a cada cliente por
   correo y WhatsApp. Con Avanza: recordatorios automáticos, tú solo revisas." This is a new
   section (not in the original section list) specifically to carry the clarified pain-point
   framing before diving into sectors/features.
3. **Sectores que atendemos** — 5 cards: Notaría, Contaduría, Legal, Seguros, Recursos Humanos
   (matches `organizations.industry`'s real enum), each with a stock photo + 1-2 lines tying the
   sector to the chasing-clients problem specifically.
4. **Cómo funciona** — 3 steps: (1) Crea tu Blueprint una vez, (2) Da de alta al cliente y Avanza
   persigue los requisitos por ti, (3) Solo entras a revisar cuando todo está listo.
5. **Soluciones** — 4-5 alternating image+text blocks: Blueprints reutilizables, Portal del
   cliente, Recordatorios automáticos (the centerpiece — explicitly the automation of the chasing
   pain point), Gestión documental con progreso real de subida, Firma de cumplimiento.
6. **Pricing** — Starter ($599 MXN/mes) and Professional ($1,499 MXN/mes, "Pronto" badge,
   visually disabled), bullets exactly as given by the user.
7. **FAQ** — 6-8 questions (security, supported sectors, trial, support, data migration,
   cancellation), marked up as real accordion content (not JS-only) plus FAQPage JSON-LD.
8. **CTA final + Footer** — WhatsApp + signup CTA, footer with basic links.

Floating persistent WhatsApp button (bottom-right) present on the whole page, in addition to the
Hero and final-CTA buttons.

## WhatsApp CTA

`https://wa.me/529514082852?text=<url-encoded message>`, message content related to Avanza (e.g.
"Hola, quiero saber más sobre Avanza para dejar de perseguir documentos de mis clientes."). All
three CTA instances (hero, floating button, final CTA) point at the same number; message text may
vary slightly per placement but stays on-topic.

## SEO + GEO

- Full `metadata` export: title, description (built around the pain point), OpenGraph, Twitter
  card, canonical URL.
- JSON-LD: `SoftwareApplication` (with pricing offers), `FAQPage` (mirrors the real FAQ content),
  `Organization`.
- Real semantic HTML: one `<h1>`, proper heading hierarchy, `<section>`s with `aria-label`, and
  actual prose (not image-only) describing each sector/solution — this is what makes the page
  legible to an LLM doing GEO, not just a search crawler.
- `robots.txt` / `sitemap.xml` added if not already present (repo has neither today — added as
  static files under `src/app/`).

## Images

Stock photos are approved by the user. Source: Unsplash-hosted images via direct `https://images.unsplash.com/...` URLs (Unsplash's license permits hotlinking/use without attribution required; this avoids downloading/reproducing files from arbitrary untrusted sources). Used via `next/image` with `remotePatterns` allowing `images.unsplash.com`. Alt text on every image describes the sector/solution shown (also feeds SEO).

## Design system

Reuses existing tokens from `globals.css` (royal blue brand, cool neutrals, `--radius-card`,
`--shadow-md`, Geist fonts) — no new design tokens. New landing-specific components live under
`src/app/(marketing)/` or directly alongside `page.tsx` in a `landing/` subfolder, kept separate
from the authenticated app's own components.

## Out of scope

- No CMS / no editable-by-non-engineers copy.
- No blog, no case studies, no testimonials (no real customer quotes exist yet).
- No A/B testing or analytics wiring beyond what's already in the app (if anything).
- No changes to `/login`, `/signup`, or any authenticated route beyond the `/` redirect logic.
