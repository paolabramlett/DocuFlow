## Context

Two cardinality assumptions in the initial schema are wrong for the notary-first domain and cheap to fix only while there is no UI and no production data: a Case has one Client, and Requirements are a flat list. This change introduces Participants and Stages, re-points grants at Participants, narrows Client authorization to a Participant's Requirements, and folds in three review refinements (channel-agnostic delivery, the reminder-function split, and a tenant-immutability guard).

The scoping decision that governs the whole change: **fix cardinality and authorization, add no machinery.** No permission matrices, no role hierarchies, no conditional workflows, no elaborate Blueprint participant logic, no full Requirement versioning. Role labels are descriptive text; a single default Stage must need no special handling; email stays the only channel.

This reshapes the security-critical path — Client reads move from whole-Case to per-Participant — so the change is as much about the isolation tests as the schema.

## Goals / Non-Goals

**Goals:**

- A Case with several parties, each an Organization-owned Client in a role, each with its own revocable grant and its own Requirements.
- Client authorization scoped to the Requirements of the Participant it is granted on; Staff see the whole Case.
- Stages as first-class ordered entities on Blueprints and Cases, deep-copied on clone with mappings preserved, usable as a single default Stage.
- Channel-agnostic reminder delivery with selection/queuing unaware of the provider, and reminders evaluated per Participant.
- Supersede-not-mutate for satisfied Requirements, keeping Document/Review/Audit history unambiguous.

**Non-Goals:**

- Configurable permissions, role-driven authorization, conditional or multi-step workflows.
- Full Requirement versioning or event-sourcing.
- Non-email channels (the model prepares; only email ships).
- Moving a Case between Organizations (explicitly forbidden, and guarded).
- Any UI.

## Decisions

### D1: Participant is the new subject of a grant; the resolver gains a Participant dimension

`case_participants(id, organization_id, case_id, client_id, role_label, …)` sits between Client and grant. `case_access_grants` references `participant_id` (and keeps `organization_id`, `case_id` denormalized for RLS and the composite-FK integrity pattern). `client_id` on the grant is dropped as an authority — the Client is reached through the Participant — though it may be retained as a denormalized convenience if a read path needs it.

A new resolver `app.granted_participant_ids(min_permission)` returns the Participants the caller holds an active grant on, using the **same** activity definition as `granted_case_ids` (verified, not revoked, not expired, permission met). `granted_case_ids` is redefined in terms of it: a Case is visible to a Client if they hold an active grant on any of its Participants. There remains one definition of "active grant."

Requirement RLS for Clients becomes: `participant_id in (select app.granted_participant_ids('view'))`. Upload requires `('upload')`. Staff access is unchanged (`organization_id in member_org_ids()`).

**Alternative rejected — keep grants on `(client, case)` and add a participant tag.** It leaves two sources of truth for "who is this grant for" and reintroduces the whole-Case visibility this change exists to remove.

### D2: Unassigned Requirements are Staff-only in this change

A Requirement's `participant_id` is nullable. Null means Case-level: visible to Staff, invisible to every Client, because the Client RLS predicate matches on `participant_id in granted_participant_ids(...)` and null is not in that set.

Null is **not** a stand-in for "shared with everyone." Sharing must be modelled explicitly, never inferred from null, precisely to avoid over-exposure inside a multi-party Case: an appraisal may be relevant to all parties without every party being entitled to view, download, or replace it. A future `audience` dimension (`staff_only` / `assigned_participant` / `all_participants`) is the right home for sharing, and is explicitly **not** in this change. Until it exists, `participant_id != null → visible to the assigned Participant`, `participant_id = null → Staff only`.

A Requirement's `participant_id` and `stage_id` are protected by composite foreign keys so a Requirement can never be assigned to a Participant or Stage of another Case or Organization — the same mechanical integrity the rest of the schema relies on.

### D3: Stages are real tables, deep-copied on clone

`blueprint_stages(id, organization_id, blueprint_id, name, position)` and `case_stages(id, organization_id, case_id, name, position)`. `requirements.stage_id` references `case_stages` (nullable). Blueprint requirement definitions (still jsonb, unchanged in spirit) carry a stage reference by ordinal.

Cloning, in `create_case`, now: copies `blueprint_stages` → `case_stages` in order, builds an ordinal→new-stage-id map, then creates Requirements assigning each to the mapped Stage. The deep-copy guarantee is unchanged — no live reference from Case back to Blueprint.

A Case with one Stage is the degenerate, zero-special-case path: one `case_stages` row, every Requirement pointing at it (or at null).

**Alternative rejected — stages as a jsonb array or a free-text column on requirements.** The scoping decision explicitly asked for first-class ordered entities so a future UI can reorder and rename stages relationally.

### D4: Grant issuance and the invitation flow target a Participant

`issueInvitation` takes a `participantId` instead of a `clientId`, and reads the invited email from the **Participant's Client** row. Everything downstream of the token (OTP dispatch, verification binding, revocation, reissue) is unchanged in shape; it now hangs off the Participant. The "the flow accepts no caller-supplied address" property is preserved — the address still comes from the Client row reached through the Participant.

### D5: Channel-agnostic delivery

`reminder_deliveries` replaces `sent_to_email` with `channel text` (constrained; `email` only for now) and `destination text`. The unique idempotency key stays `(participant_id-derived case scope, cadence_window)` — see D6. The Edge Function's Resend call moves behind a `DeliveryAdapter` keyed by channel; `drainReminderQueue` selects an adapter by the row's channel and never mentions Resend. Selection and queuing reference neither.

### D6: Reminders are per Participant, and the selection function is split

The cadence window is now computed per Participant grant. `reminder_deliveries` gains `participant_id`; the idempotency unique becomes `(participant_id, cadence_window)`. Eligibility is: the Participant's grant is active, the Case is open, and at least one **non-deleted Requirement assigned to that Participant** is unsatisfied.

`app.select_due_reminders()` is split:

- `app.eligible_reminders()` — pure, side-effect-free selection returning the due (participant, window, destination) tuples. Directly testable without writing anything.
- `app.queue_reminders()` — calls `eligible_reminders()` and performs the guarded insert (`on conflict do nothing`). This is what pg_cron runs.

One function, one question. The determinism and idempotency arguments are unchanged; they now key on Participant.

### D7: Supersede-not-mutate for satisfied Requirements

The **semantic** decision lives in the service layer, not a trigger, because "materially changes what is asked" is a judgment the caller makes, not a column comparison — the database cannot reliably tell "fix a typo in the label" from "change national-ID to passport." The rules:

- Cosmetic or presentational change → in-place edit.
- Change of `type` → always supersede.
- Material change to what is asked → supersede.
- A satisfied/approved Requirement → cannot be materially edited, only superseded.
- Supersede archives the original and creates a new outstanding Requirement carrying the new ask.
- The original's Documents and Reviews stay linked to the original, untouched.
- The audit records the relationship between the two.

Superseding is recorded with **explicit fields**, not a generic status: `superseded_at timestamptz` and `superseded_by_requirement_id uuid`. A generic `archived` state is kept as a *separate* concept (a Requirement manually retired), because a later release will want to distinguish "a Staff member archived this" from "this was replaced by a specific successor." Requirement status therefore carries both `archived` (manual) and the supersession pointer (replacement); they are not the same event.

The **mechanical** integrity is the database's job: `superseded_by_requirement_id` is a self-referential FK guarded so that it cannot form a cycle, cannot point at the Requirement itself, and cannot cross into another Case or Organization (enforced via the composite `(id, case_id, organization_id)` key, so a successor is always in the same Case). The database keeps Documents, Reviews, and Audit append-only regardless; this decision governs the workflow layer that sits above those guarantees.

### D8: `cases.organization_id` is immutable

A `BEFORE UPDATE` trigger rejects any change to `cases.organization_id`. Moving a Case between Organizations is not a use case and must never become an accidental one; the composite FKs already make it structurally hard, and this makes intent explicit and enforced.

### D9: One Client may be several Participants of the same Case

There is **no** unique constraint on `(case_id, client_id)`. The same person can genuinely hold distinct roles in one transaction — a buyer who is also the legal representative of a company — and each role is a separate Participant with its own grant and its own assigned Requirements. Uniqueness is on the Participant id alone. Accidental duplicate participants are an application-level concern (the create flow warns), not a database constraint, because the database cannot tell an accidental duplicate from a deliberate second role.

### D10: A Case may be a draft with no Participants, but cannot act without one

A Case may exist in a `draft` state with no Participants. The natural flow is: create Case → add one or more Participants → create/assign Requirements → issue invitations. Case creation does **not** force a Participant in the same step, and there is no hidden default Participant — an implicit "primary client" would produce Requirements assigned to nobody the user chose, invitations to an artificial party, and special-casing between Blueprint and blank Cases.

A draft Case therefore **cannot**: issue invitations, activate follow-up (reminders), or advance to `waiting_for_client`, until it has at least one Participant with at least one assigned Requirement. These gates are enforced in the service layer; the database enforces the structural facts they rest on (a grant needs a Participant; a reminder needs an assigned Requirement).

### D11: `participant_ready` and `case_ready` are different events

With multiple Participants, "done" splits in two:

- **`participant_ready`** — every non-deleted, non-superseded Requirement *assigned to that Participant* is satisfied.
- **`case_ready`** — every non-deleted, non-superseded Requirement of the Case, *including Staff-internal unassigned ones*, is satisfied.

The MVP emits only `case_ready` (as today), but its query must be computed correctly under the new model: it counts outstanding Requirements across the whole Case, includes unassigned ones, and excludes deleted and superseded ones. `participant_ready` is a future notification; the model supports it but this change does not emit it.

Crucially, the two readiness notions do not couple to reminders the same way: **unassigned (Staff-internal) Requirements never block a Client's reminders** — a Client is chased only for its own Participant's outstanding work — but they *can* keep the whole Case from being `case_ready`. Reminder eligibility (per Participant, per D6) and Case completion (whole-Case) are deliberately different queries.

## Risks / Trade-offs

- **The authorization change is the risk surface.** Client reads narrow from Case to Participant; a policy that still keys on Case would over-share across Participants. → New negative tests are mandatory: a Client granted on Participant A must not read, upload to, or detect Participant B's Requirements in the same Case. This is the D12-equivalent for this change.
- **Every existing grant/reminder test changes shape.** Fixtures create a Participant and grant against it rather than a Client+Case pair. → The `grantVerifiedAccess` helper and the world fixtures are updated once, centrally; test intent is preserved.
- **Two resolvers now exist for grant activity (case and participant).** → `granted_case_ids` is redefined in terms of `granted_participant_ids`, so there is still one activity definition, not two.
- **Per-Participant reminders multiply delivery rows.** A three-party Case produces up to three reminder streams. → Correct by intent; the idempotency key includes `participant_id`, so streams stay independent and none double-sends.
- **Supersede logic in the service layer could be bypassed by a direct table write.** → Staff writes go through the service layer; the database still guarantees history-preservation (append-only Documents/Reviews/Audit) regardless, so the worst case of a bypass is a mutated label, not lost history.
- **Nullable `participant_id` + nullable `stage_id` add two optional dimensions to Requirements.** → Both default to null (Case-level, no stage), the degenerate path needs no special handling, and the active-requirements view continues to centralize the `deleted_at` filter.

## Migration Plan

No production data. Applied forward as ordered migrations; existing archived migrations are not rewritten.

1. `case_participants` (+ composite unique `(id, organization_id)`, `(id, case_id, organization_id)`), RLS, grants.
2. `blueprint_stages` and `case_stages`, RLS, grants.
3. Alter `case_access_grants`: add `participant_id` FK; make it the authority; adjust RLS.
4. Alter `requirements`: add `participant_id` and `stage_id` FKs; extend status with an archived/cancelled value; adjust RLS to the Participant predicate.
5. Resolvers: add `app.granted_participant_ids`, redefine `app.granted_case_ids` in terms of it.
6. Rework `create_case` to copy stages and map Requirements; create a first Participant path.
7. Alter `reminder_deliveries`: `channel` + `destination`, `participant_id`, new unique key.
8. Split `select_due_reminders` into `eligible_reminders` + `queue_reminders`; update the cron to call `queue_reminders`.
9. `cases.organization_id` immutability trigger.
10. Regenerate types; update fixtures, service modules, and the Edge Function adapter; add the per-Participant isolation tests.

Each table ships with RLS in its own migration, as before.

## Open Questions

- **Shared Case-level Requirements.** Whether a Client should ever see an unassigned Requirement (a document every party must provide once). Deferred; D2 keeps them Staff-only for now, reversibly.
- **Blank Case default Participant.** When Staff create a Case without a Blueprint, is the first Participant created explicitly, or does a "primary" Participant get created automatically? Resolve during implementation; leaning explicit, to avoid a hidden default.
- **Material-change definition for supersession.** D7 treats a type change as material and a typo as cosmetic; the exact boundary (e.g., changing instructions) is a workflow call to firm up with the first UI.
