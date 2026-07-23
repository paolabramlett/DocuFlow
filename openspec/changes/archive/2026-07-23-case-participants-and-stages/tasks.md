## 1. Participants

- [x] 1.1 Create `case_participants` (organization_id, case_id, client_id, role_label) with composite FKs to case and client, `(id, organization_id)` and `(id, case_id, organization_id)` unique keys, RLS, and grants
- [x] 1.2 RLS: readable by Members of the org, and by the Client identity granted on that Participant; no cross-org reach
- [x] 1.3 Deliberately do NOT add a `(case_id, client_id)` unique constraint; uniqueness is on participant id, so one Client can hold multiple roles
- [x] 1.4 Test participants are tenant-consistent with their case and client, that a client reads only its own participant, and that one client may be two participants of one case

## 2. Stages

- [x] 2.1 Create `blueprint_stages` and `case_stages` (organization_id, parent, name, position) with composite FKs, RLS, and grants
- [x] 2.2 Add `requirements.stage_id` referencing `case_stages` (nullable), with the tenant-consistency composite FK
- [x] 2.3 Test stages are ordered, tenant-isolated, and that a one-stage case behaves like a flat list

## 3. Grants re-pointed at Participants

- [x] 3.1 Alter `case_access_grants` to reference `participant_id` (composite FK), make it the authority, keep organization_id/case_id denormalized
- [x] 3.2 Add `app.granted_participant_ids(min_permission)` as SECURITY DEFINER STABLE, pinned search_path, matching the existing active-grant definition
- [x] 3.3 Redefine `app.granted_case_ids` in terms of `granted_participant_ids` so there is one activity definition
- [x] 3.4 Update grant RLS and revoke/execute grants; document both resolvers as security-critical
- [x] 3.5 Test expiry, revocation, and permission apply per participant, and that two participants of one case are granted independently

## 4. Requirement assignment and authorization

- [x] 4.1 Add `requirements.participant_id` (nullable, composite FK), extend status with an archived/cancelled value
- [x] 4.2 Rewrite requirement RLS: clients see only `participant_id in granted_participant_ids('view')`; staff see all; unassigned are staff-only
- [x] 4.3 Rewrite document RLS/upload to require an `upload` grant on the requirement's participant
- [x] 4.4 Update the active-requirements view and any dependent queries for the new columns
- [x] 4.5 Test the blocking intra-Case isolation property for a client on Participant A against Participant B's requirements in the same case: (a) not in listings; (b) direct-by-UUID returns zero rows; (c) requirement metadata unreadable; (d) documents unreadable; (e) no signed URL issued; (f) cannot upload via B's requirement path; (g) existence not inferable from differing errors; (h) receives no reminders about B; (i) receives no notifications about B; (j) revoking A's grant ends access on the next request
- [x] 4.6 Test unassigned requirements are staff-only and invisible to every client, and that Staff see both participants' requirements plus unassigned ones

## 5. Cloning and Case creation

- [x] 5.1 Extend blueprint requirement definitions to carry a stage reference by ordinal
- [x] 5.2 Rework `create_case` to deep-copy blueprint stages into case stages and map each cloned requirement to its stage
- [x] 5.3 Implement the explicit first-Participant path for Case creation — no hidden default; a Case may be a draft with no Participants
- [x] 5.4 Gate draft Cases in the service layer: no invitation, no reminder activation, no client-facing state until at least one Participant has an assigned Requirement
- [x] 5.5 Test clone preserves stage placement, that editing/deleting blueprint stages does not affect existing cases, and that a participant-less draft Case cannot invite or activate follow-up

## 6. Supersede-not-mutate for satisfied Requirements

- [x] 6.1 Add `superseded_at` and `superseded_by_requirement_id` (self-referential composite FK) to `requirements`, distinct from a manual `archived` status
- [x] 6.2 Guard the supersession pointer in the DB: no self-reference, no cycle, same Case and Organization only
- [x] 6.3 Implement the service-layer rule: material change or `type` change to a satisfied requirement supersedes (archive original, create successor); cosmetic edit updates in place; a satisfied requirement cannot be materially edited
- [x] 6.4 Keep the original's Documents and Reviews linked to it; the audit records the supersession relationship
- [x] 6.5 Test a type change supersedes with history preserved and the link recorded, a typo fix does not, and the DB rejects a self-referential or cross-case supersession

## 7. Reminders: per-Participant and channel-agnostic

- [x] 7.1 Alter `reminder_deliveries`: replace `sent_to_email` with `channel` + `destination`, add `participant_id`, change the unique key to `(participant_id, cadence_window)`
- [x] 7.2 Split `app.select_due_reminders` into `app.eligible_reminders()` (pure) and `app.queue_reminders()` (insert); point the cron at `queue_reminders`
- [x] 7.3 Recompute eligibility per participant: active grant, open case, at least one outstanding assigned requirement
- [x] 7.4 Introduce a `DeliveryAdapter` keyed by channel; move the Resend call behind it; keep selection/queuing provider-unaware
- [x] 7.5 Test only participants with outstanding assigned work are chased, each keyed independently, and that a second run queues nothing
- [x] 7.6 Test the delivery record names channel and destination and carries no body

## 8. Readiness and tenant immutability

- [x] 8.1 Update the `case_ready` trigger to count outstanding Requirements across the whole Case, including unassigned, excluding deleted and superseded
- [x] 8.2 Test `case_ready` fires only when every live Requirement (assigned and unassigned) is satisfied, and that a finished Participant alone does not complete the Case
- [x] 8.3 Add a BEFORE UPDATE trigger rejecting any change to `cases.organization_id`
- [x] 8.4 Test that moving a case between organizations is refused

## 9. Verification and Handoff

- [x] 9.1 Regenerate TypeScript types; update fixtures (`grantVerifiedAccess`, world builders) to create a Participant and grant against it
- [x] 9.2 Update service modules (invitations, documents, cases, reminders) for the participant and stage dimensions
- [x] 9.3 Extend the cross-tenant sweep and schema guards to cover the three new tables
- [x] 9.4 Run the full suite from a clean db reset; confirm typecheck, lint, and all tests pass
- [x] 9.5 Update docs/architecture.md with the Participant/Stage model, the participant resolver, and the channel-agnostic delivery path
- [x] 9.6 Record the resolved open questions (blank-case participant, material-change boundary) in design.md
