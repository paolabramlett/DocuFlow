## Why

DocuFlow has a confirmed product record and domain model but no database. Every capability the MVP needs — cases, requirements, uploads, reviews, reminders — reads and writes tenant-scoped data, so the schema and its isolation guarantees are the first thing that must exist and the last thing that can be safely retrofitted.

Two properties are cheap to establish now and expensive to add later: **organization isolation enforced in the database rather than the application**, and an **identity model that lets one person be a client of many organizations without any of them sharing data**. Building the schema without them would force the rebuild in six months that this project explicitly refuses to accept.

## What Changes

- Create the initial PostgreSQL schema for the core domain: `organizations`, `members`, `clients`, `blueprints`, `cases`, `case_access_grants`, `requirements`, `documents`, `reviews`, `audit_events`.
- Enforce tenant isolation with Row Level Security on **every** exposed table. No table ships without a policy; RLS is the authorization mechanism, not a second layer behind application checks.
- Model `Client` as a durable, organization-owned record, distinct from `Case Access`, which is an explicit, revocable, expiring grant.
- Link each `Client` to a persistent passwordless Supabase Auth identity (`auth.users.id`) created or reused on first verified email. Authorization attaches to the **grant**, never to the email address or the authentication session.
- Verify client access by **email OTP code**. An invitation URL carries Case context only and grants nothing on its own; access exists only after the invited email is verified.
- Give grants a permission level (`upload`, `view`, `none`) held independently of grant state, plus rolling TTL (default 90 days, renewable), automatic downgrade to `view` for a configurable window on Case completion, and manual revocation at any time.
- Model `Requirement` polymorphically with a `type` discriminator. Only `document` is implemented; the column and its constraints exist so `text`, `date`, `confirmation`, `payment`, `signature`, and `form` are additive.
- Clone Blueprints into fully independent Cases. Blueprint edits must never propagate to existing Cases; this is enforced by copy-on-create, not by reference.
- Store uploads in private Supabase Storage buckets under organization-scoped paths, reachable only through short-lived signed URLs.
- Record every consequential action as an append-only `audit_event`. No updates, no deletes.

## Capabilities

### New Capabilities

- `organization-tenancy`: Organizations, membership, Owner/Staff roles, and the RLS foundation every other table builds on. Owns the isolation invariant.
- `client-identity`: Organization-owned Client records, their link to a persistent passwordless auth identity, OTP email verification, and the rules keeping one human's presence in multiple organizations mutually invisible.
- `case-access`: Grant lifecycle — issuance, OTP verification, permission levels, rolling expiry, completion downgrade, and revocation.
- `case-workflow`: Blueprints, clone-to-Case semantics and independence, Cases, and polymorphic Requirements including per-Case add/rename/delete/reorder.
- `document-review`: Document upload to private storage, signed-URL access, and Staff approve/reject Reviews.
- `audit-trail`: Append-only audit event recording and its read scope.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first change in the project.

## Impact

**Creates:** Supabase project schema, SQL migrations, RLS policies, storage bucket configuration, generated TypeScript types, and seed/test fixtures for a two-organization isolation harness.

**Depends on:** Supabase (Postgres, Auth, Storage) as committed in `PRODUCT.md`. No new dependencies introduced.

**Establishes contracts later work cannot renegotiate cheaply:** the tenant boundary, the `Client` / `Case Access` split, grant-based authorization, and audit immutability. Downstream UI, reminders, and any future requirement type build on these.

**Explicitly out of scope for this change:** `reminder_deliveries` and the email delivery pipeline (a follow-up change), all application UI, any requirement type other than `document`, the unified cross-organization client view, and cross-organization document reuse.

**Risk if isolation is wrong:** a defect in a single RLS policy exposes one organization's client documents to another. Verification is therefore part of the change, not a later hardening pass: every table gets a negative test proving a member of organization A cannot read, write, or detect rows belonging to organization B.
