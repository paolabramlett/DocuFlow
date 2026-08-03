# Case Closure (Complete / Cancel / Reopen) — Design

## Context

The previous change (`0a9f6b4`, `9969e9c`) separated "documentación completa" (every client-visible
Requirement approved) from "expediente finalizado" (the Case itself is done) and deliberately
deferred the latter. This spec is that deferred "Siguiente cambio."

Three moments must stay distinct in the product:

```
Documentación completa   → the client's documentation responsibility is done
Expediente completado    → the service finished successfully
Expediente cancelado     → the service ended without completing
```

Most of the schema and one trigger for this already exist and are already tested, unused by the
product:

- `cases.state` (`'open' | 'completed' | 'cancelled'`), `cases.completed_at`
  (`supabase/migrations/20260722194111_cases_and_access.sql`).
- `app.downgrade_grants_on_completion()` — a trigger that, on `state → 'completed'`, downgrades
  every active grant on the Case to `permission = 'view'` with a new
  `expires_at = now() + organizations.access_retention_days`.
- `setCaseState()` in `src/features/cases/cases.ts` — a generic state-transition use case, audited,
  but wired to nothing (only a test calls it).

This spec builds on top of that machinery rather than replacing it, but does replace
`setCaseState()` (see below) because its current shape can't hold the new requirements
(atomic validation, mandatory cancellation note, actor, multi-participant completeness).

**Explicitly out of scope, deferred:**
- Restoring access for a grant that already expired or was revoked before reopening — the staff
  member re-invites through the existing invitation flow.
- Any distinction between "operationally done" and "legally/definitively closed" — one closure
  action for now.
- Any state beyond `open` / `completed` / `cancelled` (no "abandoned", "archived", etc.).
- Per-organization timezone for the "Completados hoy" metric (see Metric section).

## Data model

### `cases` table

- **Rename** `completed_at` → `closed_at` — it now marks entry into *either* terminal state, not
  only `completed`.
- **Add** `closed_by_auth_user_id uuid references auth.users(id) on delete set null` — nullable
  forever, even after being set once. It is provenance, not the audit trail; `on delete set null`
  can legitimately blank it if the acting user is later deleted, and the real record of "who closed
  this" lives in `audit_events`, not here.
- **Add** `client_closing_note text` — **visible to the client**: shown in the Portal's read-only
  view and in the closure email. Never a place for internal staff notes. Required (enforced in SQL,
  not only in application code) when `state = 'cancelled'`; optional when `state = 'completed'`.

```sql
alter table public.cases rename column completed_at to closed_at;

alter table public.cases
  add column closed_by_auth_user_id uuid references auth.users (id) on delete set null,
  add column client_closing_note text;

-- Preflight/backfill: the OLD constraint only required completed_at for state = 'completed', so a
-- pre-existing 'cancelled' Case (if any exist) may have closed_at (post-rename) still null. The
-- new coherence constraint below would reject the migration outright on such a row. There is no
-- better source for "when this was cancelled" than updated_at (no history table exists), so this
-- is a deliberate, documented approximation — not a guess about what data exists today.
update public.cases
   set closed_at = updated_at
 where state = 'cancelled'
   and closed_at is null;

alter table public.cases
  drop constraint cases_completed_at_matches_state;

alter table public.cases
  add constraint cases_closed_at_matches_state check (
    (state in ('completed', 'cancelled')) = (closed_at is not null)
  ),
  add constraint cases_cancelled_requires_note check (
    state <> 'cancelled' or nullif(btrim(client_closing_note), '') is not null
  );
```

### `organizations` table

- **Add** `grant_reactivation_days integer not null default 90 check (grant_reactivation_days between 1 and 3650)`
  — same shape as the existing `access_retention_days`. This is the canonical source for how long a
  restored grant stays active after reopening a Case; it must never be duplicated as a bare number
  inside a trigger, and it is intentionally a *different* knob from `access_retention_days` (one
  governs the read-only window after closing, the other governs the active window after reopening).

```sql
alter table public.organizations
  add column grant_reactivation_days integer not null default 90
    check (grant_reactivation_days between 1 and 3650);
```

### `case_access_grants` table

- **Add** `permission_before_closure text` — the grant's `permission` value at the moment it was
  first downgraded, so reopening can restore the *actual* prior value rather than assuming
  `'upload'`. Set only on the `open → terminal` transition (never overwritten on a later
  terminal-to-terminal transition, which this spec forbids outright — see Transitions below).
  Cleared on every `terminal → open` transition, whether or not that particular grant was
  restorable.

```sql
alter table public.case_access_grants
  add column permission_before_closure text
    check (permission_before_closure is null or permission_before_closure in ('upload', 'view', 'none'));
```

Same three-value domain as `permission` itself (`'upload' | 'view' | 'none'`) — an unconstrained
`text` column would let a future bug write an impossible value that the reopen trigger would later
try to restore verbatim.

## Transitions

Only two transitions exist. Anything else is rejected by the RPC, not silently coerced:

```
open       → completed   (close_case, outcome = 'completed')
open       → cancelled   (close_case, outcome = 'cancelled')
completed  → open        (reopen_case)
cancelled  → open        (reopen_case)
```

`completed → cancelled` and `cancelled → completed` are **not** allowed directly. To change a
verdict, reopen first, then close again with the new outcome. This keeps every trigger's condition
a simple `old.state = 'open' and new.state in (...)` or its mirror, instead of a matrix of
terminal-to-terminal cases.

## `close_case` RPC

`security invoker` — RLS applies exactly as it does to any other Staff write today
(`cases_update_by_member` already restricts the `UPDATE` to the caller's own Organization; no
elevated privilege is needed).

**Concurrency, corrected.** The initial read locks the row with `FOR UPDATE`: a second concurrent
call blocks there until the first transaction commits or rolls back, and — because `FOR UPDATE`
under `READ COMMITTED` re-fetches the latest *committed* row once the lock is granted — it then
sees the already-updated `state` and fails its own precondition check, never overwriting the first
call's result. The `WHERE ... AND state = 'open'` on the `UPDATE` itself is a second, independent
layer of defense (belt-and-suspenders: correct even if the lock strategy above were ever changed),
not a replacement for the lock. The audit event is written inside the same transaction as the state
change — not by the TypeScript caller afterwards — so there is no window where the Case is closed
but no record of who closed it exists; a later step (email) can still fail without that meaning the
closure or its audit trail are in question.

```sql
create or replace function public.close_case(
  p_case_id uuid,
  p_outcome text,
  p_closing_note text default null
)
returns public.cases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases;
  v_visible_total integer;
  v_visible_outstanding integer;
  v_rows integer;
begin
  if p_outcome not in ('completed', 'cancelled') then
    raise exception 'close_case: invalid outcome %', p_outcome;
  end if;

  -- FOR UPDATE: holds the row lock for the rest of this transaction. A concurrent close_case (or
  -- reopen_case) on the same Case blocks here until this transaction ends.
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    raise exception 'close_case: no such case';
  end if;
  if v_case.state <> 'open' then
    raise exception 'close_case: case is not open (state: %)', v_case.state;
  end if;

  if p_outcome = 'completed' then
    -- "Documentación completa", computed here rather than trusted from the caller, and covering
    -- every Participant of the Case, not just the one whose Requirement last changed: at least one
    -- client-visible Requirement exists, and every one of them is satisfied. Staff-only
    -- Requirements (participant_id is null) and soft-deleted/superseded rows never count either
    -- way — this matches the existing read models (src/features/cases/queries.ts,
    -- src/features/case-access/portal-queries.ts) exactly, including that a Requirement whose
    -- status is 'archived' (a real, distinct value of requirements.status, not a synonym for
    -- deleted_at) still counts as outstanding here, precisely because those read models never
    -- special-case it either. A Case with two Participants where only one finished their
    -- documentation must NOT be completable. case_participants has no soft-delete/active flag
    -- today, so there is no "inactive participant" to additionally exclude.
    select count(*), count(*) filter (where r.status <> 'satisfied')
      into v_visible_total, v_visible_outstanding
      from public.requirements r
     where r.case_id = p_case_id
       and r.participant_id is not null
       and r.deleted_at is null
       and r.superseded_at is null;

    if v_visible_total = 0 or v_visible_outstanding > 0 then
      raise exception 'close_case: documentation is not complete';
    end if;
  else
    if nullif(btrim(p_closing_note), '') is null then
      raise exception 'close_case: closing note is required to cancel';
    end if;
  end if;

  update public.cases
     set state = p_outcome,
         closed_at = now(),
         closed_by_auth_user_id = (select auth.uid()),
         client_closing_note = case
           when p_outcome = 'cancelled' then btrim(p_closing_note)
           else nullif(btrim(coalesce(p_closing_note, '')), '')
         end
   where id = p_case_id
     and state = 'open';

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- Reached only if RLS silently dropped the UPDATE (a Client can SELECT this row via a 'view'
    -- grant but never UPDATE it) — the FOR UPDATE lock plus the state check above already rule out
    -- a genuine concurrent-transition race reaching here. Must never look the same as "not found".
    raise exception 'close_case: not authorized';
  end if;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_case.organization_id, p_case_id, 'case.state_changed', 'case', p_case_id,
    'member', (select auth.uid()), jsonb_build_object('from', 'open', 'to', p_outcome)
  );

  select * into v_case from public.cases where id = p_case_id;
  return v_case;
end;
$$;

revoke all on function public.close_case(uuid, text, text) from public;
grant execute on function public.close_case(uuid, text, text) to authenticated;
```

`client_closing_note` normalization happens in SQL, not trusted from TypeScript already normalized:
cancellation always stores the trimmed note (checked non-blank before the `UPDATE` even runs, so
the failure is a clean early exception rather than a constraint violation from the `UPDATE`),
completion stores `null` unless a real non-blank note was actually passed.

## `reopen_case` RPC

Also `security invoker`, also locks with `FOR UPDATE` and re-checks state on the `UPDATE` itself,
for the identical reason as `close_case`. Restores every grant that is still genuinely alive by the
system's **one existing definition of "active"** (`app.granted_participant_ids`'s own predicate:
`verified_at is not null and revoked_at is null and expires_at > now()` — the earlier draft was
missing the `verified_at` clause, which would have let an *unverified, never-activated* grant row
be "restored" as if it had been a real prior session), tolerates grants with no recorded prior
permission, and reports the **deduplicated set of Participants** restored — the RPC itself
deduplicates, via `select distinct`, rather than promising a shape it doesn't produce and pushing
the fix into the TypeScript caller.

```sql
create or replace function public.reopen_case(p_case_id uuid)
returns table (participant_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_case public.cases;
  v_rows integer;
  v_reactivation_days integer;
begin
  select * into v_case from public.cases where id = p_case_id for update;
  if not found then
    raise exception 'reopen_case: no such case';
  end if;
  if v_case.state not in ('completed', 'cancelled') then
    raise exception 'reopen_case: case is not in a terminal state (state: %)', v_case.state;
  end if;

  select o.grant_reactivation_days into v_reactivation_days
    from public.organizations o
   where o.id = v_case.organization_id;

  update public.cases
     set state = 'open',
         closed_at = null,
         closed_by_auth_user_id = null,
         client_closing_note = null
   where id = p_case_id
     and state in ('completed', 'cancelled');

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'reopen_case: not authorized';
  end if;

  insert into public.audit_events (
    organization_id, case_id, action, target_type, target_id,
    actor_kind, actor_auth_user_id, metadata
  ) values (
    v_case.organization_id, p_case_id, 'case.state_changed', 'case', p_case_id,
    'member', (select auth.uid()), jsonb_build_object('from', v_case.state, 'to', 'open')
  );

  -- Restorable: the canonical "active grant" predicate (verified, not revoked, not expired) AND a
  -- real prior permission was captured. A grant whose permission_before_closure is null never had
  -- one recorded (e.g. it was already 'view' going in) — never invent 'upload' for it. RETURN
  -- QUERY appends rows and does not exit the function, so the cleanup UPDATE below still runs
  -- before the final bare RETURN, and the DISTINCT here is the RPC's real contract, not something
  -- deferred to the caller: this Case's grants carry no uniqueness constraint on participant_id
  -- alone, so more than one grant row per Participant is possible and must not produce duplicates.
  return query
    with restored as (
      update public.case_access_grants g
         set permission = g.permission_before_closure,
             expires_at = now() + make_interval(days => v_reactivation_days),
             permission_before_closure = null
       where g.case_id = p_case_id
         and g.verified_at is not null
         and g.revoked_at is null
         and g.expires_at > now()
         and g.permission_before_closure is not null
      returning g.participant_id
    )
    select distinct r.participant_id from restored r;

  -- Every other grant on this Case that still carries a stale prior-permission value (expired,
  -- revoked, or never verified — so never restored above) gets it cleared too — no transient state
  -- left dangling, whether or not that particular grant's access actually came back.
  update public.case_access_grants g
     set permission_before_closure = null
   where g.case_id = p_case_id
     and g.permission_before_closure is not null;

  return;
end;
$$;

revoke all on function public.reopen_case(uuid) from public;
grant execute on function public.reopen_case(uuid) to authenticated;
```

Behavior:
- `permission_before_closure is null` → never restored, but still cleared to `null` (a no-op) so no
  stale value lingers.
- Expired, revoked, or never verified → **left unchanged**, not "left at `view`" — a grant could
  have been revoked entirely, not merely downgraded, and this must not overwrite that.
- Returns one row per Participant actually restored, genuinely deduplicated by the RPC's own
  `select distinct` — never a promise the TypeScript layer has to keep on the RPC's behalf.

## Trigger changes

`app.downgrade_grants_on_completion()` is renamed to `app.downgrade_grants_on_closure()` and its
condition generalizes from "entering `completed`" to "entering either terminal state, from `open`
specifically" (transitions are `open → terminal` only, so `old.state = 'open'` is equivalent to,
and clearer than, `old.state is distinct from new.state`). Its `WHERE` clause is also corrected to
the **same canonical "active grant" predicate** used everywhere else
(`app.granted_participant_ids`) instead of the narrower `revoked_at is null` alone the earlier draft
had — the original hand-written condition would have "downgraded" (and given a brand-new
`expires_at`) a grant that had already expired, effectively reviving it:

```sql
if new.state in ('completed', 'cancelled') and old.state = 'open' then
  update public.case_access_grants g
     set permission_before_closure = g.permission,
         permission = 'view',
         expires_at = now() + make_interval(days => retention_days)
   where g.case_id = new.id
     and g.verified_at is not null
     and g.revoked_at is null
     and g.expires_at > now();
end if;
```

(`retention_days` continues to come from `organizations.access_retention_days`, unchanged.) There
must be exactly one definition of "active grant" in this schema — this spec never introduces a
second one for the downgrade/restore path.

No new trigger is needed for reopening — `reopen_case` does that work directly and needs to return
which Participants were restored, which a trigger fired from a generic `UPDATE ... SET state =
'open'` could not hand back to the caller.

## Application layer (`src/features/cases/cases.ts`)

`setCaseState()` is removed (nothing outside its own test calls it) and replaced by two functions
that call the RPCs and own the notification side effects. Neither calls `recordAuditEvent` —
the audit event is already written, atomically, inside the RPC itself (see above); a second write
from TypeScript would double the trail entry.

```ts
export async function closeCase(
  client: DbClient,
  caseId: string,
  outcome: 'completed' | 'cancelled',
  closingNote: string | undefined,
): Promise<void> {
  const { error } = await client.rpc('close_case', {
    p_case_id: caseId,
    p_outcome: outcome,
    p_closing_note: closingNote ?? null,
  });
  if (error) throw new UseCaseError(mapCloseCaseError(error), ...);

  await notifyParticipantsOfClosure(client, caseId, outcome, closingNote); // best-effort, try/catch
}

export async function reopenCase(
  client: DbClient,
  caseId: string,
): Promise<{ restoredParticipantIds: string[]; requiresReinvitation: boolean }> {
  const { data, error } = await client.rpc('reopen_case', { p_case_id: caseId });
  if (error) throw new UseCaseError(mapReopenCaseError(error), ...);

  // The RPC's own `select distinct` is the real guarantee of uniqueness here — this reads its
  // result directly rather than re-deduplicating a set the RPC's contract already promises.
  const restoredParticipantIds = (data ?? []).map((r) => r.participant_id);

  if (restoredParticipantIds.length > 0) {
    await notifyParticipantsOfReopening(client, caseId, restoredParticipantIds); // best-effort
  }

  return { restoredParticipantIds, requiresReinvitation: restoredParticipantIds.length === 0 };
}
```

Neither function takes `actorAuthUserId` as a parameter anymore — the RPC reads `auth.uid()`
directly inside the same transaction as the state change, exactly like `closed_by_auth_user_id` and
the audit event's `actor_auth_user_id`, so there is no actor identity to pass in from a layer above
that could ever disagree with what the database itself recorded.

Both notification helpers follow the existing `reviewDocument`/`notifyParticipantActionRequired`
pattern exactly: wrapped in their own try/catch, logged-and-swallowed on failure, never able to
undo or fail the state transition that already committed. Both iterate **Participants**, not grant
rows (a Participant could in principle hold more than one grant row; sending one email per
Participant, not per row, is what avoids a duplicate send and — for reopening — avoids calling
`emit_participant_invitation` more than once per Participant, which would invalidate a token this
same loop just minted for them).

`notifyParticipantsOfClosure` looks up, per Participant with an active grant, their invited email
and sends "Expediente completado" or "Expediente cancelado" (with `client_closing_note` when
present). `notifyParticipantsOfReopening` calls `reissueParticipantInvitation` once per restored
Participant (never per grant) and sends "Tu expediente fue reabierto" with the fresh
`/portal/{token}` link — never a stale one.

## Server Actions (`src/app/cases/actions.ts`)

```ts
closeCaseAction(caseId: string, outcome: 'completed' | 'cancelled', closingNote?: string): Promise<ActionResult<null>>
reopenCaseAction(caseId: string): Promise<ActionResult<{ requiresReinvitation: boolean }>>
```

Same thin shape as every other action here: `getStaffContext()`, delegate, `revalidatePath('/cases')`.

## Email

Two new templates (or one with a variant, matching the existing rejection-notification style):
**"Expediente completado"** and **"Expediente cancelado"** (renders `client_closing_note` when
present) — sent to every Participant with an active grant, always (no per-send toggle, consistent
with the rest of the product having none). Plus **"Expediente reabierto"**, sent only to
Participants actually restored by `reopen_case`, carrying a freshly reissued Portal link.

**Escaping.** `client_closing_note` is staff-entered free text rendered into an HTML email (and,
per the UI section below, into the Staff and Portal banners). It goes through a shared
`escapeHtml()` utility before being interpolated into any HTML template — never raw string
interpolation. (In the course of this design, the existing rejection-notification email was found
to interpolate its `reason` field into HTML with no escaping at all — a pre-existing gap, not
introduced here, flagged separately rather than folded into this spec's scope. This spec's own new
templates must not repeat that pattern, and adding the shared `escapeHtml()` utility as part of this
work is the natural place to close both at once if the plan chooses to.)

## UI

**Staff (`cases-workspace.tsx`):** a new "Cerrar expediente" button next to "Descargar todo" /
"Recordar". Opens a small modal: radio `Completado` / `Cancelado`. `Completado` is disabled with an
inline reason when documentation isn't complete for every Participant (mirrors the RPC's own
condition, computed client-side from the same `CaseView` data already in memory, purely for UX —
the RPC is still the enforcement). `Cancelado` requires a non-empty textarea, labeled explicitly
**"Motivo de cancelación (el cliente lo verá)"**. On success, the existing "Documentación completa"
banner is replaced by a new, distinct banner for `completed` or `cancelled`, showing who closed it,
when, the note, and a "Reabrir expediente" button. If reopening returns
`requiresReinvitation: true`, the Staff UI surfaces that explicitly ("El cliente ya no tiene un
enlace activo — usa Recordar para invitarlo de nuevo") rather than implying access was restored.

**Client Portal:** when `state !== 'open'`, the active checklist is replaced by a read-only view
with the corresponding message (completed or cancelled + `client_closing_note`). Every Requirement
that has a Document — approved, rejected, or still in review, doesn't matter — gets Ver/Descargar,
not only approved ones (no backend change needed: `getClientDocumentUrl` already checks ownership
only, never review state; `deriveState` in `portal-queries.ts` already attaches `documentId`/
`fileName` on every branch). Upload controls disappear entirely, matching the grant's real
downgraded `permission = 'view'`.

## Metric: "Completados hoy"

Computed as a real database `COUNT`, never by pulling rows and comparing dates in TypeScript. This
changes `getOperativeCounts`'s signature: today it only takes the already-fetched `CaseView[]`
(sufficient for the other three counts, which only need what's already loaded for the workspace
list) and returns `completedToday: 0` unconditionally. It gains a `client: DbClient` and
`organizationId: string` parameter so it can issue one additional, precise `COUNT`-only query —
still exactly one extra round trip, not a second full fetch of every Case.

The day boundary is calculated in TypeScript using `Intl.DateTimeFormat`, backed by the real ICU
timezone database — never manual offset arithmetic (no hardcoded "subtract 6 hours"). The technique
(ends up as a small, independently unit-testable pure function,
`src/lib/time/zoned-day-boundary.ts`):

1. Read the target zone's current wall-clock year/month/day via
   `new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)`.
2. Build a UTC "candidate" instant for midnight of that Y-M-D via `Date.UTC(...)`.
3. Ask `Intl.DateTimeFormat` (with `timeZoneName: 'shortOffset'`) what the zone's actual UTC offset
   is *at that candidate instant*, and subtract it from the candidate. Because a timezone's offset
   is piecewise-constant and changes only at well-known transition instants, one correction (two at
   most, to handle the edge case where the correction itself crosses a transition) converges to the
   exact UTC instant of local midnight — this is exactly how offset-aware libraries solve the same
   problem, just without adding a dependency for one function.
4. `daysFromNow` shifts which local day is being asked about (`0` = today's local midnight, `1` =
   tomorrow's), so both boundaries come from the same function.

`America/Mexico_City` is used as a fixed, single, product-wide zone for this metric — an explicit
MVP simplification (not per-organization), stated as such in code, not silently assumed.

```ts
const startOfTodayUtc = zonedDayBoundaryToUtc(new Date(), 'America/Mexico_City', 0);
const startOfTomorrowUtc = zonedDayBoundaryToUtc(new Date(), 'America/Mexico_City', 1);

const { count } = await client
  .from('cases')
  .select('id', { count: 'exact', head: true })
  .eq('organization_id', organizationId)
  .eq('state', 'completed')
  .gte('closed_at', startOfTodayUtc.toISOString())
  .lt('closed_at', startOfTomorrowUtc.toISOString());
```

Cancelled Cases never count here — this metric is about finished work, not closed-for-any-reason
Cases. `zoned-day-boundary.ts` gets its own unit tests against known instants, including at least
one real historical UTC-offset transition, to prove step 3 above actually converges rather than
merely looking correct on today's date.

## Testing

- **Isolation tests** (new): `close_case` — rejects a non-`open` Case (including directly attempting
  `completed → cancelled` or `cancelled → completed`, which must fail exactly like any other
  non-`open` starting state, proving those transitions are genuinely impossible, not merely
  undocumented); rejects `completed` when any Participant has an outstanding client-visible
  Requirement; rejects `completed` when there are zero client-visible Requirements at all; a
  Requirement with `status = 'archived'` still counts as outstanding (not silently excluded);
  rejects `cancelled` with a blank/whitespace-only note; the audit event exists in the same
  transaction as the state change (assert both are visible together, never one without the other);
  a Client (grant-only, no membership) cannot call it despite being able to `SELECT` the Case. A
  genuine concurrency test — two connections opening the same Case's `close_case` call
  simultaneously (one deliberately delayed inside the transaction, e.g. via a second connection
  timed against the first's lock) — asserts exactly one commits and the other raises "case is not
  open", never both succeeding and never a silent last-write-wins. `reopen_case` — rejects a
  non-terminal Case; restores a still-active grant's exact prior permission; leaves an expired
  grant, a revoked grant, and an unverified grant all untouched (three separate cases, not folded
  into one); clears `permission_before_closure` on a never-restorable grant too; returns the
  correct, truly deduplicated Participant set (via the RPC's own `DISTINCT`, not a client-side
  workaround) when a Participant somehow holds two grant rows; the audit event exists atomically
  with the state change, same as `close_case`.
- **Integration tests**: `closeCase`/`reopenCase` — notification failures don't roll back or throw
  past the use case; reopening with zero restorable grants sends no email and reports
  `requiresReinvitation: true`; reopening calls `emit_participant_invitation` exactly once per
  restored Participant, never per grant row.
- **Regression**: existing `case-services.test.ts` (which calls the now-removed `setCaseState`) is
  rewritten against `closeCase`/`reopenCase`.
- **Unit tests**: `zoned-day-boundary.ts` against known instants, including a real historical
  UTC-offset transition, not just "today."
