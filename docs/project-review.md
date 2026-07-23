# DocuFlow — Architecture Review Brief

**Audience:** an LLM (or engineer) asked to review whether this project is on the right track, and to flag anything in the architecture, security model, scope, or engineering approach that should change.

**Written:** 2026-07-23. **State:** backend of the MVP complete; no UI yet.

This brief is self-contained. It restates the product intent, the current implementation, the load-bearing decisions and *why* they were made, and — at the end — an explicit list of things worth challenging. Read the "Please scrutinize" section last; it is where a reviewer's attention is most valuable.

Ground-truth sources in the repo, in order of authority: [`PRODUCT.md`](../PRODUCT.md) (product truth), [`docs/architecture.md`](architecture.md) (how it works), the archived OpenSpec changes under `openspec/changes/archive/**` (proposal + design + specs + tasks per change), and the migrations under `supabase/migrations/`.

---

## 1. What the product is

DocuFlow is a **workflow engine that helps businesses complete client cases** by collecting the information and documents those cases require. It exists to remove the administrative labour of chasing clients through WhatsApp, email, and spreadsheets.

It is deliberately **not** a document management system, not a Drive, not a CRM. Success is a *completed case*, not a stored file.

**Central object: the Case.** Documents are one *requirement type* inside a Case, never the centre of the system. The architecture is built so that future requirement types — payment, signature, form, date, confirmation, text — are additive, not structural.

**Central rule: identity may be shared, data never is.** One human is a client of many businesses over a lifetime (a notary, then an accountant, then a law firm). The design must serve that without ever weakening tenant isolation.

**Market:** notaries first, then any administrative business (accountants, legal, insurance, HR, …). One engine; industry selection changes only terminology, starter content, help, and examples — never the engine.

**Owner:** a UX/UI designer who will design every screen in Figma later, and who asked for clean architecture, security as a product feature, low operational cost, and no premature abstraction. Stated stack preference: Next.js, TypeScript, Tailwind, shadcn/ui, Supabase, Resend, Vitest, Playwright, PostHog, Cloudflare.

---

## 2. Current state

Three OpenSpec changes, all implemented, verified, and archived:

1. `initial-multi-tenant-schema` — the domain, tenant isolation, and the client-access model.
2. `reminders-and-notifications` — the follow-up engine.
3. (proposal/archive bookkeeping)

**By the numbers:** 14 migrations · 12 tables · 43 RLS policies · 11 `app`-schema functions · 14 source modules · 14 test files · **170 tests passing** from a clean `db reset`, with typecheck and lint clean.

**Stack as built:** Next.js 16 (React 19), TypeScript in strict mode plus `noUncheckedIndexedAccess` and friends, Tailwind 4, Supabase (Postgres 17, Auth, Storage), Zod 4 for server-side validation, Vitest 4, Resend + a Supabase Edge Function + pg_cron for reminders, `pg` for schema-introspection tests. shadcn/ui, Playwright, PostHog, and Cloudflare are named in the product record but **not yet introduced** — there is no UI, no e2e layer, no analytics, no DNS config yet. That is expected: nothing above the database has been built.

**What exists above the database:** a thin service layer in `src/features/**` (cases, case-access/invitations, documents, reminders, audit, organizations/context) and `src/lib/**` (Supabase clients, storage paths, Zod boundary). There are **no React components, no routes, no pages** — the Next app is the scaffold only. Business logic lives in tested, framework-agnostic modules deliberately, so the UI is a thin layer over them when it arrives.

---

## 3. Domain model

```
Organization
  ├─ Members                (owner | staff)              — auth.users ↔ org, role-scoped
  ├─ Clients                durable, org-owned            — nullable link to auth.users
  ├─ Blueprints             starting points, owner-curated
  ├─ Cases                  the central object
  │    ├─ Case Access grants temporary, revocable, per-Case
  │    ├─ Requirements       polymorphic by `type` (only `document` live)
  │    │    └─ Documents      private storage + signed URLs
  │    │         └─ Reviews    approve/reject, append-only history
  │    ├─ Reminder Deliveries scheduled follow-up records
  │    └─ Staff Notifications event-driven, review_needed | case_ready
  └─ Audit Events           append-only, org-scoped
```

Key relationships and why they are shaped this way:

- **Client vs Case Access are separate on purpose.** A Client is who the org serves and endures across Cases; a grant is a scoped, expiring, revocable permission to *one* Case. Collapsing them would erase client history on every return engagement.
- **Blueprint → clone → independent Case.** Cloning deep-copies requirement definitions into real rows; a later Blueprint edit or delete cannot reach an existing Case. Enforced by there being no live reference to follow (`origin_blueprint_id` is provenance-only, `ON DELETE SET NULL`).
- **Requirements carry a `type` discriminator** constrained to the full planned set; only `document` is accepted (a DB trigger rejects the rest with an explicit "unsupported" error, distinct from an invalid-type constraint violation).

---

## 4. Security model — the load-bearing decisions

Security is treated as a product feature, and enforcement lives in the **database**, not the application. The five decisions a reviewer should understand:

### D1 — Authorization reads from tables, never from JWT claims
Three `SECURITY DEFINER STABLE` functions in the unexposed `app` schema answer every policy: `member_org_ids()`, `is_org_owner(uuid)`, `granted_case_ids(min_permission)`. Membership and grants are resolved per-request from tables.

*Why not JWT claims (the common, faster Supabase pattern):* a token is a snapshot; a revoked grant or removed member would stay authorized until refresh. The product requires revocation to take effect on the **next request**. Verified by test: revoke mid-session, next query returns nothing, same access token.

These functions are the privilege boundary of the whole system. Rules enforced by `schema-guard.test.ts`: pinned `search_path`, `STABLE`, no `app` function executable by `anon`.

### D2 — `organization_id` denormalized on every table, held true by composite foreign keys
No policy walks the tree to find the tenant. Every child declares `foreign key (parent_id, organization_id) references parent(id, organization_id)`, so a row whose tenant disagrees with its parent is **unrepresentable**. Flat-check performance with walked-check integrity. A schema guard asserts the composite FKs exist.

### D3 — Grant lifecycle and permission are orthogonal
Lifecycle (`verified_at` / `revoked_at` / `expires_at`) and permission (`upload` / `view` / `none`) are separate columns; both are evaluated. This makes Case completion cheap: a trigger downgrades to `view` for the org's retention window — no new state. **Expiry is evaluated at read time**, so no scheduled job can fail open.

### D4 — Invitation + OTP: holding the link is never enough
The invitation token is stored only as a SHA-256 hash and identifies a Case, granting nothing. Access requires an OTP **sent to the address on the grant row** — the flow accepts no caller-supplied address, which closes account-enumeration and mail-bombing. The email carries a *code, not a clickable link*, so a forwarded invitation is useless. On verification the grant binds to the verified `auth.users.id` and the org's Client record picks up the same identity. Throttling (60s cooldown, 5-attempt lockout) lives on the grant; attempts are audited, codes never are. Tested end-to-end through real local email delivery.

### D5 — One person, many organizations, zero data crossing
Client email is unique **per-organization, never globally** (a global unique index would leak cross-tenant presence via conflict errors). Cross-tenant existence is itself treated as confidential. One `auth.users` identity may link to Client records in many orgs; that link grants no read access by itself. A unified cross-org client portal and cross-org document reuse are explicitly deferred but reachable without migration.

**Storage:** private buckets; path leads with the tenant (`{org}/cases/{case}/requirements/{req}/{doc}`); policies parse the path and apply the same resolvers as table policies; reads are 120-second signed URLs, never persisted. Paths are built in exactly one module.

**Audit:** append-only (INSERT/SELECT policies only; UPDATE/DELETE revoked from every role including `service_role`); `target_id` carries no FK so events outlive their subjects; a denylist plus discipline keeps codes, tokens, URLs, and file contents out.

---

## 5. The follow-up engine

Two mechanisms, deliberately separate:

- **Client reminders are scheduled.** pg_cron runs `app.select_due_reminders()` every 15 min to *queue* due Cases; a Supabase Edge Function drains the queue through Resend. The cron holds no access decision and touches no external service; the Edge Function is the only outbound path and the only place the Resend key exists (a function secret).
  - **Cadence is an Organization policy** (first-delay/interval/max, default 3/7/4, hidden in the MVP UI).
  - **Idempotency is structural:** the due window is deterministic (from grant activation + interval, never `now()`); a `unique (case_id, cadence_window)` makes re-queueing a no-op; the row is written *before* the send, so the failure mode is recorded-but-unsent (visible, retryable), never sent-but-unrecorded.
  - **Suppression** (completed, revoked, expired, satisfied, capped, `none` permission) is applied in selection, reusing the *one* definition of an active grant.
- **Staff notifications are event-driven rows, not emails.** Triggers create `review_needed` on client upload and `case_ready` on the transition to zero outstanding requirements. Staff are in the product, so a row suffices; Staff email is deferred.

---

## 6. Deliberate scope boundaries (do not flag these as gaps)

**Out of the MVP by decision:** AI, e-signatures, payments, CRM, chat, WhatsApp/SMS, advanced automation, analytics, marketplace, the unified cross-org client view, cross-org document reuse, Staff notification emails, non-`document` requirement types, and any UI.

**Resolved decisions (settled, with rationale in `design.md`):** Supabase region `us-east-1`; retention window = org policy default 90d; client session = 1h sliding inactivity + 24h absolute timebox; cadence defaults 3/7/4.

---

## 7. Known open items (already tracked)

- **Cadence defaults (3/7/4)** are guesses about notary rhythm; cheap to change (a column).
- **Staff `staff` role is not yet scopeable to a subset of Cases** — fine for small teams, deferred to avoid premature generalization.
- **Accessibility standard is undecided** — flagged in `PRODUCT.md` as an open decision to settle before UI, since Client-role users are external parties on unknown devices/AT.
- **Hosted deployment not done** — everything runs on local Supabase. Deploy requires: create the hosted project (us-east-1), push migrations, wire Edge Function secrets (Resend key, from-address, app origin), and schedule the drain (the queue cron is in a migration; triggering the *sender* Edge Function is a deploy-time step, intentionally not a cron command carrying a service-role key).

---

## 8. Please scrutinize — where reviewer attention is most valuable

These are the decisions I am least certain about, or where a reasonable architect might push back. A review that engages here is more useful than one that re-confirms the parts already tested.

1. **Business logic in tested service modules vs. Postgres functions.** Some invariants live in the DB (grant activity, completion downgrade, notification triggers, requirement-type rejection); others live in TypeScript service modules (`src/features/**`). Is the split in the right place? Specifically: should the OTP/invitation flow's orchestration be closer to the DB, or is the current app-layer placement correct? Is there logic in TS that a future non-Next consumer would need and therefore belongs in the DB?

2. **`SECURITY DEFINER` surface area.** There are 11 `app` functions, several `SECURITY DEFINER`. Each is a potential privilege-escalation point. Is the set minimal? Is `select_due_reminders` (which reads across all tenants) too broad, and should the reminder queue be built a different way?

3. **Denormalized `organization_id` + composite FKs.** This buys performance and integrity but adds a unique key and a wider FK to every table. At the MVP's scale it is free; is it the right long-term bet, or will it complicate schema evolution (e.g., moving a Case between orgs, which is currently impossible by construction — is that a requirement that will surface)?

4. **Reminder delivery architecture (pg_cron + Edge Function + Resend).** This keeps HTTP and secrets out of the database, but splits the engine across three runtimes. Is that the right trade vs. a single scheduled worker? The *sender* Edge Function's scheduling is a manual deploy step — is that acceptable, or a reliability gap?

5. **Read-time expiry evaluation.** Every authorized query re-evaluates grant expiry inside a `STABLE` function. Correct and fail-safe, but is the per-query cost acceptable as case/grant volume grows, and are the supporting indexes right?

6. **No UI, no e2e, no observability yet.** Playwright, PostHog, and Cloudflare are planned but absent. Is deferring all three until the UI exists the right sequencing, or should any land now (e.g., basic error observability before the first deploy)?

7. **Testing strategy.** Tests drive the DB through PostgREST as each principal (never the service role for assertions), with a cross-tenant sweep and schema guards. Is the coverage model sound? Are there isolation properties the sweep could miss? Is the reliance on a live local Supabase stack in CI a fragility?

8. **Cost and operational surface.** The product wants low operational cost. Current external dependencies: Supabase, Resend, (planned) PostHog, Cloudflare. Is anything over-built for a validation-stage product, or conversely, is any critical reliability/observability piece missing that would hurt at first real usage?

9. **Multi-industry via one engine.** Industry changes only terminology/starter-content/help/examples. Is that abstraction boundary drawn correctly, or will a second industry (accounting, legal) reveal engine-level assumptions baked in during the notary-first build?

10. **The Client/Case-Access/identity model at scale.** The "identity shared, data never" rule is enforced by per-org uniqueness and grant-based reads. Is there an attack or a product requirement (e.g., the future unified portal) that this model handles poorly, and is the deferral genuinely migration-free?
```
