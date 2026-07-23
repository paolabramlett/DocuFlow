## Why

DocuFlow's mission is to reduce the manual administrative follow-up required to complete a client case. The schema can hold cases and collect documents, but nothing yet chases the client, so a Staff member must still remember who has not responded and email them by hand — exactly the labour the product exists to remove.

This change adds the follow-up engine: scheduled reminders that pursue the Client for outstanding requirements, and event-driven notifications that tell Staff when a Case needs their attention. It is the last backend piece of the MVP that does not depend on the forthcoming UI.

## What Changes

- Add a `reminder_deliveries` table recording every reminder attempted or sent against a Case, so cadence is derived from history rather than guessed, and no reminder is sent twice.
- Add reminder cadence as an **Organization policy** (first reminder after N days, repeat every M days, capped at a maximum count), defaulting sensibly and hidden from the MVP UI — the same pattern as `access_retention_days`.
- Schedule reminders with **pg_cron**, which selects Cases with due reminders and invokes an **Edge Function** that sends via **Resend**. No scheduled job ever holds the decision to *whether* access is open; it only sends mail.
- Send the Client a reminder only while there is something to do: an open Case, an active grant, and at least one outstanding requirement. A completed, cancelled, revoked, or fully-satisfied Case is never chased.
- Add **event-driven Staff notifications** — not a periodic digest — fired when a Case reaches a state that needs a person: a Document is uploaded (review needed), or every requirement becomes satisfied (Case ready to complete).
- Record every send and every suppression as an audit event, so the trail explains not only what was sent but what was deliberately not.
- Make delivery **idempotent and rate-aware**: a cron run that overlaps a previous one, or retries after a partial failure, must not double-send.

## Capabilities

### New Capabilities

- `client-reminders`: The scheduled follow-up engine — cadence policy, due-selection, the delivery record, suppression rules, and the send path through Resend.
- `staff-notifications`: Event-driven alerts to Staff when a Case needs attention, and the rules that decide which state changes warrant one.

### Modified Capabilities

- `organization-tenancy`: Organizations gain reminder-cadence policy columns. The isolation model is unchanged; this adds configuration fields, not new access paths.
- `case-workflow`: Case and Requirement state changes become triggers for notifications. Existing behaviour is unchanged; this observes state, it does not alter it.

## Impact

**Creates:** `reminder_deliveries` and `staff_notifications` tables with RLS; reminder-cadence columns on `organizations`; a pg_cron schedule; a Supabase Edge Function that calls Resend; Zod schemas and a server module for the send path; migrations and tests including a local delivery harness.

**Depends on:** Resend (committed in `PRODUCT.md`) and pg_cron (bundled with Supabase). The Resend API key is an Edge Function secret, never in the database or the client. Introduces no dependency not already named.

**Reuses, does not renegotiate:** the tenant boundary, the grant resolvers, and the audit trail from the initial schema. Reminders read grant state through the same `app.granted_case_ids` logic; a reminder is only ever sent for a Case whose grant is active.

**Explicitly out of scope:** WhatsApp and SMS (email only for the MVP), Staff digest emails (Staff get event-driven notifications only), client-configurable cadence, and any reminder for a requirement type other than `document`.

**Risk if delivery is wrong:** the two failure modes are a missed reminder (the client is never chased — a silent regression of the product's whole purpose) and a duplicate or misdirected reminder (the client is annoyed, or a reminder reaches the wrong mailbox — a trust and privacy failure). Both are covered by tests: due-selection is asserted against a seeded clock, and idempotency is asserted by running the selection twice and proving the second run sends nothing.
