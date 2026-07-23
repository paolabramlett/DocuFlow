## 1. Organization Cadence Policy

- [x] 1.1 Add reminder-cadence columns to `organizations` (first-delay days, interval days, max count) with defaults (3 / 7 / 4) and range checks
- [x] 1.2 Regenerate TypeScript types and confirm the columns default without breaking `create_organization`
- [x] 1.3 Test that cadence columns default on creation, reject out-of-range values, and stay tenant-isolated

## 2. Reminder Deliveries Table

- [x] 2.1 Create `reminder_deliveries` with organization_id, case_id, grant_id, status (queued/sent/failed), attempt_count, cadence_window, timestamps, and composite foreign keys to the tenant
- [x] 2.2 Add the unique constraint on `(case_id, cadence_window)` that makes queueing idempotent
- [x] 2.3 Enable RLS: members of the owning organization read only; no client access; no cross-organization reach
- [x] 2.4 Add grants and confirm the schema-guard suite still passes with the new table

## 3. Due Selection

- [x] 3.1 Implement the deterministic cadence-window bucket from grant activation time, interval, and reminder ordinal — never from now()
- [x] 3.2 Implement `app.select_due_reminders()` as SECURITY DEFINER STABLE, pinned search_path, reusing the existing active-grant logic
- [x] 3.3 Exclude completed, cancelled, revoked, fully-satisfied, and cap-reached cases from selection
- [x] 3.4 Revoke execute from API roles; document the function as security-critical
- [x] 3.5 Test due-selection against a seeded clock: cases just before and just after the first-delay and interval boundaries
- [x] 3.6 Test each suppression rule excludes its case, and that the cap stops further reminders
- [x] 3.7 Test idempotency: run selection twice and prove the second run queues nothing

## 4. Staff Notifications

- [x] 4.1 Create `staff_notifications` with organization_id, case_id, reason (review_needed/case_ready), target_type, target_id, timestamps, and RLS
- [x] 4.2 Add the trigger on `documents` insert that creates a `review_needed` notification, distinguishing a client uploader from a staff uploader
- [x] 4.3 Add the edge-triggered check on `requirements` that creates `case_ready` only on the transition to fully-satisfied
- [x] 4.4 Confirm no notification stores document contents, URLs, or credentials
- [x] 4.5 Test upload-by-client notifies and upload-by-staff does not
- [x] 4.6 Test that the final approval fires `case_ready` and a non-final approval does not
- [x] 4.7 Test notifications are staff-only and tenant-isolated

## 5. Send Path

- [x] 5.1 Add Zod schemas for the reminder send payload and the Resend response
- [x] 5.2 Implement the server module that reads a queued delivery, sends via Resend to the grant address, and marks sent/failed
- [x] 5.3 Retry failed deliveries up to a bound; leave exhausted ones marked failed for inspection
- [x] 5.4 Record every send and suppression as an audit event carrying no body or URL
- [x] 5.5 Build the Supabase Edge Function that drains queued deliveries, with the Resend key as a function secret
- [x] 5.6 Test the send targets the grant address, never a caller-supplied one
- [x] 5.7 Test a failed send is recorded and retried, and an exhausted one is left visible

## 6. Scheduling

- [x] 6.1 Add the pg_cron schedule that queues due reminders, enabling pg_cron locally if needed
- [x] 6.2 Verify the schedule invokes selection without holding any access decision
- [x] 6.3 Document the reminder engine, the cadence-window bucket, and the queued→sent lifecycle in docs/architecture.md

## 7. Verification and Handoff

- [x] 7.1 Run the full suite from a clean db reset; confirm typecheck, lint, and all tests pass
- [x] 7.2 Confirm the cross-tenant sweep and schema guards cover the two new tables
- [x] 7.3 Update the CI workflow if the Edge Function or pg_cron needs a step
- [x] 7.4 Record resolved cadence defaults and local-pg_cron decisions in design.md
