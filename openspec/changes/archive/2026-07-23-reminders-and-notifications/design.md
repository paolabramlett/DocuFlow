## Context

The initial schema can hold Cases and collect Documents but does nothing unprompted. This change adds the follow-up engine that is the product's reason to exist. It builds entirely on the existing tenant model, grant resolvers, and audit trail; it renegotiates none of them.

Two mechanisms that look similar and must not be merged:

- **Client reminders** are *scheduled*. They ask a clock: which Cases are overdue for a nudge? They run on pg_cron and select from delivery history.
- **Staff notifications** are *event-driven*. They ask a state change: did something just happen that a person must act on? They fire from database triggers at the moment of the change.

Conflating them would produce either a digest that arrives too late to be event-driven, or a cron job trying to detect events after the fact. They stay separate.

## Goals / Non-Goals

**Goals:**

- Reminders that pursue the Client only while there is genuinely something to do, on a cadence each Organization controls without a code change.
- Delivery that is idempotent under overlap and retry: a reminder is the kind of side effect that must not happen twice.
- Staff notifications that fire at the moment a Case needs attention, with no periodic polling.
- A send path where the Resend key lives in an Edge Function secret and never in the database or the browser.

**Non-Goals:**

- WhatsApp or SMS. Email only for the MVP.
- Staff digest emails. Staff get event-driven notifications; the daily-summary idea is explicitly out.
- Client-configurable or per-Case cadence. Cadence is an Organization policy, hidden in the MVP.
- Delivering the actual notification email to Staff. This change records the notification and leaves email-out for Staff to a later change; the record is what the UI will read. Client reminders *do* send email, because that is the mission.

## Decisions

### D1: pg_cron selects, an Edge Function sends

pg_cron runs a small SQL function on a schedule that inserts a `reminder_deliveries` row for every due Case in a `queued` state, then an Edge Function picks up queued rows, calls Resend, and marks each `sent` or `failed`.

**Why the split.** Postgres must never hold the Resend API key or make outbound HTTP as a matter of course — that puts a credential and a network dependency inside the database, untestable and hard to audit. The Edge Function is where the outside world is touched; SQL only decides *who* is due. This also keeps the whole thing runnable locally: the selection is pure SQL, tested directly, and the send is a function tested against Resend's test mode or a captured request.

**Alternative rejected — GitHub Actions cron hitting a Next route.** It requires the app deployed to send a single email, and puts the reminder engine behind a public HTTP surface guarded only by a shared secret. pg_cron needs nothing deployed and exposes no endpoint.

**Alternative rejected — pg_net calling Resend from inside Postgres.** Fewer moving parts, but it is exactly the credential-and-HTTP-in-the-database that D1 exists to avoid.

### D2: The delivery record is the idempotency key, not a lock

Due-selection reads the last `reminder_deliveries` row per Case and computes the next due time from it. The insert of a new `queued` row is guarded by a unique constraint on `(case_id, cadence_window)` — a deterministic bucket derived from the grant activation time and the cadence interval — so two overlapping cron runs cannot both insert for the same window. The second insert conflicts and does nothing.

This is preferred over an advisory lock around the cron job because it survives a crash between selection and send: the record exists before the email is attempted, so a retry sees it and does not re-queue. The failure mode is a reminder that is recorded-but-unsent (visible, retryable), never sent-but-unrecorded (invisible, potentially duplicated).

### D3: Due-selection is a SECURITY DEFINER function, scoped to sending only

The selection function reads across Organizations — it must, to serve every tenant's cron in one pass — so it is `SECURITY DEFINER` and follows the same rules as the authorization resolvers: no dynamic SQL, pinned `search_path`, and a single narrow job. It returns only what the sender needs (delivery id, grant email, case title, organization name) and touches nothing else. It is not exposed to any API role; only the cron job and the service role invoke it.

Crucially it reuses the *existing* grant-activity logic rather than re-deriving it: a Case is a reminder candidate only if it would pass `app.granted_case_ids` for its Client. There is one definition of "active grant" in the system, and reminders honour it.

### D4: Suppression is a first-class outcome, recorded not skipped

A Case that is due by the clock but should not be chased — grant revoked, Case completed, all requirements satisfied, cap reached — is not silently skipped. The selection excludes it, and where the distinction matters for the audit trail, a suppression is recorded. This makes "why did this client stop getting reminders?" answerable from the record rather than inferred from an absence.

### D5: Staff notifications are trigger-emitted rows, not emails (yet)

A trigger on `documents` insert creates a `review_needed` notification; a trigger on `requirements` reaching all-satisfied creates a `case_ready` notification. These are rows the Staff UI will read, not emails — sending Staff email is a separate concern deferred out of this change, because Staff are logged into the product and a row they see on next load is sufficient for the MVP, whereas the Client is absent and must be reached by email.

The upload trigger distinguishes a Client uploader from a Staff uploader: a Staff member uploading on the client's behalf does not need to notify themselves.

### D6: All-satisfied detection is edge-triggered

`case_ready` fires only on the *transition* to fully-satisfied — when the last outstanding requirement flips to satisfied — not on every approval. The trigger checks whether any outstanding requirement remains after the change; a `case_ready` is created only when none does. This keeps one notification per Case-becoming-ready rather than one per approval.

## Risks / Trade-offs

- **A missed reminder silently regresses the product's whole purpose** → due-selection is asserted against a seeded clock with cases positioned just before and just after each cadence boundary, so an off-by-one in the interval math fails a test rather than quietly under-sending.
- **A duplicated or misdirected reminder is a trust and privacy failure** → idempotency is asserted by running the selection twice and proving the second run queues nothing; the target address comes from the grant row, never a parameter, mirroring the OTP flow.
- **pg_cron running while the Edge Function is down backs up queued rows** → queued rows are durable and the sender is idempotent, so recovery is draining the backlog, not reconstructing it. A stuck `queued` row is visible, unlike a lost in-memory job.
- **Resend outage or rate limit** → a failed send marks the row `failed` with an attempt count; the sender retries failed rows up to a bound before leaving them for inspection. No failure is swallowed.
- **The cadence-window bucket must be deterministic or idempotency breaks** → it is computed from fixed inputs (grant activation time, interval, reminder ordinal), never from `now()`, so the same window yields the same bucket on every run. Covered by a direct test.
- **Trigger-emitted notifications add write amplification to hot paths** → the triggers are single-row inserts with no cross-table scans on the upload path; the all-satisfied check is one indexed count on the Case. Acceptable for the MVP's volumes, and revisitable behind the same table if not.

## Migration Plan

Nothing to migrate from. Applied forward as ordered migrations:

1. Reminder-cadence columns on `organizations`, with defaults and range checks.
2. `reminder_deliveries` with its unique cadence-window constraint, RLS, and grants.
3. `staff_notifications` with RLS and grants.
4. The `SECURITY DEFINER` due-selection function and its explicit revokes.
5. The notification triggers on `documents` and `requirements`.
6. The pg_cron schedule.
7. The Edge Function and its Resend secret wiring (config, not a migration).

Each table ships with RLS enabled in the same migration, as in the initial schema.

## Resolved During Implementation

- **Cadence defaults — 3 / 7 / 4.** First reminder at 3 days, repeat every 7, cap at 4, stored as `organizations.reminder_first_delay_days`, `reminder_interval_days`, `reminder_max_count`. Still a guess about notary rhythm; changing the default is one migration and changing a live Organization's value is a row update.
- **Local pg_cron — available.** `create extension pg_cron` succeeds in the local stack, so the schedule ships in a migration (`*/15 * * * *` running `app.select_due_reminders()`) and `db reset` installs it. The selection function is tested directly over a pg connection, exactly as the cron invokes it, so its correctness does not depend on the scheduler firing.
- **Resend test delivery — a fake `MailSender`.** The send path takes a `MailSender` interface; tests inject a recording or failing implementation to assert targeting, idempotency, retry, and recovery without any network call. The live Resend transport is constructed only inside the Edge Function, from a secret, so no test imports the key.
- **CI — no new step.** pg_cron is applied by migrations during `supabase start`, and `supabase/functions` is excluded from the Node typecheck and lint (it is Deno). The Edge Function is deployed separately and is not part of the test build.

## Open Questions

- **Staff notification email.** Deferred by design: Staff get notification rows, not emails, in this change. Whether Staff eventually want email for `review_needed` or `case_ready` is a later product call.
