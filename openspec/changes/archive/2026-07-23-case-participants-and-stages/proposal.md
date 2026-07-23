## Why

A review of the domain model surfaced two cardinality assumptions that are wrong for the notary-first market and expensive to correct once UI and production data exist:

1. **A Case has exactly one Client.** A real notarial transaction has several parties — buyer, seller, notary, power-of-attorney — each providing their own documents. The current single `client_id` per Case cannot express this; it forces either overloading one client or splitting one transaction into disconnected Cases.
2. **Requirements are a flat list.** As future requirement types arrive (payment, signature), a single ordered list becomes unwieldy. Work naturally groups into stages (collect documents → pay → sign).

This change corrects both **before** the UI and any production data exist, so it is a schema refactor with test updates rather than a data migration. It also folds in three refinements from the same review that are cheap now and costly later: channel-agnostic reminder delivery, a hardening guard on tenant immutability, and splitting the reminder-selection function.

It is deliberately narrow. The goal is to fix cardinality and authorization, not to build workflow machinery.

## What Changes

- **BREAKING (pre-production):** Add `case_participants`. A Case has one or more Participants; each links an Organization-owned Client to the Case with an editable role label, and may hold its own revocable Case Access grant.
- **BREAKING (pre-production):** Case Access grants attach to a **Participant**, not directly to a `(client, case)` pair. A Client identity may view and act on only the Requirements assigned to the Participant its active grant is for.
- Requirements gain an optional `participant_id` (unassigned = Case-level, Staff-managed) and an optional `stage_id`.
- Add `blueprint_stages` and `case_stages` as first-class ordered entities. Blueprint cloning deep-copies stages and preserves each Requirement's stage mapping. The MVP may present a single default stage; the domain supports several without migration.
- Prevent destructive semantic edits to a **satisfied** Requirement: a material change (or any `type` change) supersedes — the original is archived and a new Requirement is created — via explicit `superseded_at` / `superseded_by_requirement_id` fields, kept distinct from a manual `archived` state. The original keeps its Documents and Reviews; the audit records the link. Full Requirement versioning is **not** introduced.
- Allow one Client to be several Participants of the same Case (distinct roles); no `(case_id, client_id)` unique constraint.
- Compute `case_ready` correctly across the whole Case (including Staff-internal unassigned Requirements, excluding superseded/deleted); model `participant_ready` as distinct but emit only `case_ready`.
- Refactor `reminder_deliveries` from email-specific fields to a generic `channel` + `destination`. Email stays the only MVP channel; provider specifics stay inside the delivery adapter / Edge Function. Selection and queuing become unaware of Resend or any channel.
- Reminders become **per-Participant**: a Participant with an active grant and outstanding assigned Requirements is chased on the Organization's cadence.
- Split `app.select_due_reminders()` into `app.eligible_reminders()` (pure selection) and `app.queue_reminders()` (the insert). One function, one question.
- Add a guard making `cases.organization_id` immutable — a Case can never move between Organizations.

## Capabilities

### New Capabilities

- `case-participants`: The Participant entity — role label, Client linkage, per-Participant grant, Requirement assignment, and the rule scoping a Client identity to its own Participant's Requirements.
- `case-stages`: Stages as first-class ordered entities on Blueprints and Cases, Requirement-to-stage mapping, and stage-preserving clone.

### Modified Capabilities

- `case-access`: Grants attach to a Participant. The active-grant resolvers gain a participant dimension; Client visibility narrows from whole-Case to assigned Requirements.
- `case-workflow`: Requirements gain participant and stage assignment; cloning copies stages and mappings; satisfied Requirements are superseded rather than mutated on material change.
- `document-review`: Client upload and read authorization is scoped to the Requirements of the Participant the Client is granted on.
- `client-reminders`: Reminders are per-Participant, and delivery is channel-agnostic; selection stays provider-unaware. `select_due_reminders` is split.
- `staff-notifications`: `case_ready` is computed across the whole Case (including unassigned, excluding superseded/deleted); `participant_ready` is modelled but not emitted.

## Impact

**Creates:** `case_participants`, `blueprint_stages`, `case_stages`; `participant_id` and `stage_id` on `requirements`; `channel`/`destination` on `reminder_deliveries`; new resolver `app.granted_participant_ids`; split reminder functions; a `cases.organization_id` immutability guard. Migrations, regenerated types, and test/fixture updates throughout.

**Changes the authorization model:** Client reads move from "any Requirement of a Case I'm granted on" to "Requirements assigned to my Participant." This is the security-critical part of the change and is covered by new negative tests: a Client granted on Participant A cannot see Participant B's Requirements in the same Case.

**Reuses, does not renegotiate:** tenant isolation, composite foreign keys, the audit trail, the grant lifecycle (verified/revoked/expired) and permission levels, and read-time expiry. Participants and stages slot into the existing model; they do not alter how tenancy or grant activity is enforced.

**Explicitly out of scope (per the scoping decision):** configurable permission matrices, role hierarchies, conditional workflows, complex Blueprint participant logic, full Requirement versioning, non-email channels, and any UI. Unassigned (Case-level) Requirements are Staff-managed in this change; whether a future release lets a Client see shared Case-level Requirements is left open.
