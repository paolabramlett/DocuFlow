# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary users — business teams inside an organization.** Initial market is notaries. The architecture must serve future markets without changing the core engine: accountants, law firms, insurance brokers, mortgage brokers, HR departments, construction, healthcare, and administrative businesses generally.

Three roles, with distinct jobs:

- **Owner** — manages the organization, its members, and its Blueprints. Full access.
- **Staff** — creates Cases, reviews documents, communicates with clients, manages requirements. The day-to-day operator.
- **Client** — a durable record of a person the organization serves, owned by the Organization. The Client record persists across every Case that organization runs for that person. Access to a Case is a **separate, temporary, revocable grant** (see Case Access), never an attribute of the Client. Within a granted Case: uploads files, reads comments. Never sees another Case, and never another organization's data.

The job being done: complete a client case without chasing the client through WhatsApp, email, and spreadsheets.

## Product Purpose

DocuFlow is a **workflow engine** that helps businesses complete client cases by collecting the information and documents those cases require. It exists to eliminate the administrative labor of repeated client follow-up.

Explicitly **not**: a document management system, a Google Drive, or a CRM.

Success is a **completed case**, not a stored document.

Mission: reduce the manual administrative follow-up required to complete a client case.

## Positioning

DocuFlow is a **Case Engine**. The Case is the central object of the platform; documents are one *type of requirement* inside a Case, never the center of the system.

Two commitments a neighboring product could not truthfully copy while remaining what it is:

1. **Requirements are polymorphic from the ground up.** Document collection is today's workflow, but the engine treats a document as one requirement type among future peers: payments, appointments, forms, signatures, confirmations, other client actions. A file-centric product cannot claim this without rebuilding.
2. **Blueprints are starting points, not templates.** A Blueprint is cloned into a Case, and the Case is then fully independent and editable — requirements can be added, deleted, renamed, and reordered per Case. Editing a Blueprint must **never** modify existing Cases. Template-bound workflow products cannot offer this divergence.

## Operating Context

**Multi-industry under one domain.** One product, one domain (e.g. `docuflow.com`). Each organization selects its industry during onboarding (notary, accounting, legal, insurance, HR, …). That selection determines only:

- default terminology
- starter Blueprints
- contextual help
- examples

The engine underneath is identical across industries. Separate products per industry are explicitly out of bounds.

**The core workflow:**

```
Blueprint → clone → independent, editable Case
```

Staff create a Case, invite a client, request requirements, receive uploads, review them, approve or reject, and the system sends automatic email reminders. Every meaningful action leaves an audit event.

## Capabilities and Constraints

### Domain model (source of truth)

```
Organization
  └─ Members
  └─ Clients                  durable; owned by this Organization
  └─ Blueprints
  └─ Cases
       └─ Case Access         temporary, revocable grant: Client → this Case
       └─ Requirements
            └─ Documents
                 └─ Reviews
       └─ Reminder Deliveries
       └─ Audit Events
```

**Client and Case Access are distinct on purpose.** The Client is who the organization serves and endures across Cases; Case Access is a scoped, expiring, revocable permission to one Case. Collapsing them would erase client history on every return engagement and force re-collection of information the organization already holds.

### Requirement types

MVP implements **Document** only. The architecture must not hardcode around documents; the type set is designed to expand to: Text, Date, Confirmation, and later Payment, Signature, Form.

### MVP scope — in

Create cases · create Blueprints · duplicate Blueprints into editable Cases · invite clients · request documents · receive uploads · review documents · approve/reject documents · automatic email reminders · audit trail.

### MVP scope — out (deliberate)

AI · electronic signatures · payments (until final launch) · CRM · chat · WhatsApp · advanced automation · analytics · marketplace · unified cross-organization client view · document reuse across organizations.

### Security constraints (non-negotiable, treated as product features)

- Multi-tenant from day one; every business entity belongs to an Organization.
- Row Level Security on every exposed table.
- No public storage buckets — signed URLs only.
- Organization isolation is mandatory.
- Guest (client) sessions are temporary.
- Every important action generates an audit event.
- Client-side authorization is never trusted.

Security risks are surfaced and explained before implementation, not worked around.

### One person, many organizations

A real person is a client of many businesses over a lifetime — a notary today, an accountant next year, a law firm after that, a second notary later. The platform must accommodate this at scale **without ever weakening organization isolation**.

Two things that look alike must stay separate:

- **Authentication identity** — the human who logs in. Naturally global (one verified email, one login). Shared identity is *not* shared data.
- **Client record** — an organization's record of the person it serves: name, contact details, history, notes. Always **per-Organization**. If two organizations serve the same person, each holds its own independent Client record.

Rules that follow, and that no future feature may break:

- A Client record never spans organizations, and is never merged across them.
- One authentication identity may be linked to many Client records in many organizations. That link is the only permitted connection between tenants, and it grants no read access by itself.
- Every read stays authorized by Case Access, never by "same person".
- No organization may see that a person is also a client elsewhere, nor infer it. Cross-tenant existence is itself confidential.
- Documents belong to the organization that collected them. There is no automatic reuse across organizations.

**Deliberately deferred, and reachable without a rewrite:** a unified client view (one login listing every Case that person has been granted, across organizations) is a projection over grants, not a shared data store. Any future document reuse across organizations must be a **client-initiated, per-document, explicitly consented** share — never an organization reading across the tenant boundary. Neither is in the MVP.

The only cost incurred now to keep these open: Client is durable and org-scoped, Case Access is separate, and a Client may carry a nullable link to a verified authentication identity.

### Technology constraints (stated preference)

Next.js · TypeScript (strict) · Tailwind CSS · shadcn/ui · Supabase (Postgres, Storage, Auth) · Resend · GitHub Actions · Vitest · Playwright · PostHog · Cloudflare (DNS + security).

Alternatives may be proposed, but only with the trade-offs explained first.

### Engineering constraints

Modular, feature-based organization · reusable components · server-side validation with Zod · database migrations · testable code. Avoid duplicated logic, oversized files, hidden dependencies, premature abstractions, and unnecessary libraries. Every dependency must solve a real problem.

### Cost constraint

The business is in validation. Infrastructure stays inexpensive: prefer open-source, built-in platform features, and managed services with generous free tiers. Popularity is not a reason to adopt a service.

### Terminology (canonical)

Organization · Member · Client · Blueprint · Case · Requirement · Document · Review · Reminder Delivery · Audit Event. A **Case** is the central object. A **Blueprint** is a starting point, not a fixed template.

## Brand Commitments

Working name: **DocuFlow**.

The owner is a UX/UI designer and will design every screen in Figma; designs arrive later, and implementation is expected to be production-ready from them.

Volunteered UI constraint, recorded as stated: the interface should feel modern, calm, minimal, premium, elegant, and spacious — and never bureaucratic, enterprise-heavy, cluttered, or like a generic AI dashboard. Named as reference points for information hierarchy and simplicity rather than for copying: Linear, Vercel, Stripe Dashboard, Notion.

## Evidence on Hand

**None yet.** As of 2026-07-22 the repository contains no application code, no `package.json`, and no README — only tooling installed this session (`.agents/`, `.claude/`, `openspec/`, `skills-lock.json`).

There are no customers, no testimonials, no case studies, no usage data, no benchmarks, no pricing, and no brand assets (logo, wordmark, imagery) on hand. Future work must not fabricate any of these, and must not present the notary market as a validated customer base — it is the chosen initial target, not an acquired one.

## Product Principles

1. **Design around Cases, never around files.** The Case is the central object; a document is one requirement inside it. Any decision that puts storage at the center is wrong.
2. **A Blueprint seeds a Case; it never governs one.** Cloning produces an independent, fully editable Case. Blueprint edits must not reach existing Cases.
3. **One engine, many industries.** Industry selection changes terminology, starter content, help, and examples — never the core system.
4. **Security is a product feature.** Multi-tenancy, RLS, signed URLs, organization isolation, and audit events are requirements, not hardening tasks. Convenience never overrides them.
5. **Identity may be shared; data never is.** The same human can hold one login across many organizations, and still each organization sees only its own Client record and only the Cases it granted. Convenience for the returning client is delivered through grants and consent, never by relaxing the tenant boundary.
6. **Build the right software, not the fast software.** No premature optimization, and no technical debt that forces a rebuild in six months. Ambiguity stops work and raises a question rather than producing a guess.

## Accessibility & Inclusion

**Undecided.** No accessibility standard or specific user need has been established for DocuFlow yet. This is an open decision, not an absence of requirement — it should be settled before UI implementation begins, since Client-role users are external parties on unknown devices and assistive technology.
