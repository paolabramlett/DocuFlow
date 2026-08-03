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
  add column permission_before_closure text;
```

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
elevated privilege is needed). All validation and the state change happen inside one function, so
there is no window between "checked complete" and "marked complete" for a Requirement to change
underneath the check — the entire thing is one statement-level snapshot inside a single
transaction.

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

  select * into v_case from public.cases where id = p_case_id;
  if not found then
    raise exception 'close_case: no such case';
  end if;
  if v_case.state <> 'open' then
    raise exception 'close_case: case is not open (state: %)', v_case.state;
  end if;

  if p_outcome = 'completed' then
    -- "Documentación completa", but computed here rather than trusted from the caller: at least
    -- one client-visible Requirement exists, across every Participant of the Case, and every one
    -- of them is satisfied. Staff-only Requirements (participant_id is null), archived ones
    -- (deleted_at), and superseded ones (superseded_at) never count either way. A Case with two
    -- Participants where only one finished their documentation must NOT be completable.
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
  end if;

  update public.cases
     set state = p_outcome,
         closed_at = now(),
         closed_by_auth_user_id = (select auth.uid()),
         client_closing_note = case
           when p_outcome = 'cancelled' then btrim(p_closing_note)
           else nullif(btrim(coalesce(p_closing_note, '')), '')
         end
   where id = p_case_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    -- RLS silently drops the UPDATE for a caller without membership (a Client can SELECT this row
    -- via a 'view' grant but never UPDATE it) rather than raising — that must never look the same
    -- as "not found" above, so it is checked and raised explicitly here.
    raise exception 'close_case: not authorized';
  end if;

  select * into v_case from public.cases where id = p_case_id;
  return v_case;
end;
$$;

revoke all on function public.close_case(uuid, text, text) from public;
grant execute on function public.close_case(uuid, text, text) to authenticated;
```

Note the `client_closing_note` normalization happens in SQL, not trusted from TypeScript already
normalized: cancellation always stores the trimmed note (the `not null` check constraint catches an
empty one), completion stores `null` unless a real non-blank note was actually passed.

## `reopen_case` RPC

Also `security invoker`. Restores every grant that is still genuinely alive, tolerates grants with
no recorded prior permission, and reports exactly *which* Participants got their access back — not
just a count — because notification must go only to them.

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
  select * into v_case from public.cases where id = p_case_id;
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
   where id = p_case_id;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'reopen_case: not authorized';
  end if;

  -- Restorable: still verified, not revoked, not yet expired, and actually has a prior permission
  -- recorded. A grant with permission_before_closure is null never had one captured (e.g. it was
  -- already 'view' going in) — never invent 'upload' for it. RETURN QUERY appends rows and does
  -- not exit the function, so the cleanup UPDATE below still runs before the final bare RETURN.
  return query
    update public.case_access_grants g
       set permission = g.permission_before_closure,
           expires_at = now() + make_interval(days => v_reactivation_days),
           permission_before_closure = null
     where g.case_id = p_case_id
       and g.revoked_at is null
       and g.expires_at > now()
       and g.permission_before_closure is not null
    returning g.participant_id;

  -- Every other grant on this Case that still carries a stale prior-permission value (expired or
  -- revoked, so never restored above) gets it cleared too — no transient state left dangling.
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

(The final migration task will clean up the `cleared` CTE above into something more direct — e.g.
two straight `UPDATE`s instead of one faked through a second CTE — this design fixes the *behavior*,
not the final SQL syntax.)

Behavior:
- `permission_before_closure is null` → never restored, but still cleared to `null` (a no-op) so no
  stale value lingers.
- Expired or revoked → **left unchanged**, not "left at `view`" — a grant could have been revoked
  entirely, not merely downgraded, and this must not overwrite that.
- Returns one row per Participant actually restored (deduplicated by `participant_id`, not by grant
  row — `case_access_grants` carries no uniqueness constraint on `participant_id` alone, so this
  spec never assumes exactly one grant per Participant).

## Trigger changes

`app.downgrade_grants_on_completion()` is renamed to `app.downgrade_grants_on_closure()` and its
condition generalizes from "entering `completed`" to "entering either terminal state, from `open`
specifically" (transitions are `open → terminal` only, so `old.state = 'open'` is equivalent to,
and clearer than, `old.state is distinct from new.state`):

```sql
if new.state in ('completed', 'cancelled') and old.state = 'open' then
  update public.case_access_grants g
     set permission_before_closure = g.permission,
         permission = 'view',
         expires_at = now() + make_interval(days => retention_days)
   where g.case_id = new.id
     and g.revoked_at is null;
end if;
```

(`retention_days` continues to come from `organizations.access_retention_days`, unchanged.)

No new trigger is needed for reopening — `reopen_case` does that work directly and needs to return
which Participants were restored, which a trigger fired from a generic `UPDATE ... SET state =
'open'` could not hand back to the caller.

## Application layer (`src/features/cases/cases.ts`)

`setCaseState()` is removed (nothing outside its own test calls it) and replaced by two functions
that call the RPCs and own the notification side effects:

```ts
export async function closeCase(
  client: DbClient,
  caseId: string,
  outcome: 'completed' | 'cancelled',
  closingNote: string | undefined,
  actorAuthUserId: string,
): Promise<void> {
  const { error } = await client.rpc('close_case', {
    p_case_id: caseId,
    p_outcome: outcome,
    p_closing_note: closingNote ?? null,
  });
  if (error) throw new UseCaseError(mapCloseCaseError(error), ...);

  await recordAuditEvent(client, {
    action: 'case.state_changed',
    targetType: 'case',
    targetId: caseId,
    actor: { kind: 'member', authUserId: actorAuthUserId },
    metadata: { to: outcome },
    ...
  });

  await notifyParticipantsOfClosure(client, caseId, outcome, closingNote); // best-effort, try/catch
}

export async function reopenCase(
  client: DbClient,
  caseId: string,
  actorAuthUserId: string,
): Promise<{ restoredParticipantIds: string[]; requiresReinvitation: boolean }> {
  const { data, error } = await client.rpc('reopen_case', { p_case_id: caseId });
  if (error) throw new UseCaseError(mapReopenCaseError(error), ...);

  const restoredParticipantIds = [...new Set((data ?? []).map((r) => r.participant_id))];

  await recordAuditEvent(client, { action: 'case.state_changed', metadata: { to: 'open' }, ... });

  if (restoredParticipantIds.length > 0) {
    await notifyParticipantsOfReopening(client, caseId, restoredParticipantIds); // best-effort
  }

  return { restoredParticipantIds, requiresReinvitation: restoredParticipantIds.length === 0 };
}
```

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

Computed as a real database filter, not by pulling every Case and comparing in TypeScript. The
day boundary is calculated in TypeScript (once, cheaply) as a fixed product-wide timezone —
`America/Mexico_City` — for this MVP, explicitly documented as a simplification (not
per-organization), converted to the correct UTC instants for whatever the current offset actually
is (never a flat 6-hour subtraction, which breaks across a DST-like offset change):

```ts
const startOfTodayUtc = zonedDayBoundaryToUtc(new Date(), 'America/Mexico_City', 0);
const startOfTomorrowUtc = zonedDayBoundaryToUtc(new Date(), 'America/Mexico_City', 1);
```

Then queried directly:

```ts
const { count } = await client
  .from('cases')
  .select('id', { count: 'exact', head: true })
  .eq('organization_id', organizationId)
  .eq('state', 'completed')
  .gte('closed_at', startOfTodayUtc.toISOString())
  .lt('closed_at', startOfTomorrowUtc.toISOString());
```

Cancelled Cases never count here — this metric is about finished work, not closed-for-any-reason
Cases.

## Testing

- **Isolation tests** (new): `close_case` — rejects a non-`open` Case; rejects `completed` when any
  Participant has an outstanding client-visible Requirement; rejects `completed` when there are zero
  client-visible Requirements at all; rejects `cancelled` with a blank/whitespace-only note; a
  Client (grant-only, no membership) cannot call it despite being able to `SELECT` the Case;
  concurrent calls on the same Case race correctly (one succeeds, one gets "not open"). `reopen_case`
  — rejects a non-terminal Case; restores a still-active grant's exact prior permission; leaves an
  expired grant and a revoked grant untouched; clears `permission_before_closure` on a
  never-restorable grant too; returns the correct, deduplicated Participant set when a Participant
  somehow holds two grant rows.
- **Integration tests**: `closeCase`/`reopenCase` — audit event recorded with the right actor and
  `to` value; notification failures don't roll back or throw past the use case; reopening with zero
  restorable grants sends no email and reports `requiresReinvitation: true`; reopening calls
  `emit_participant_invitation` exactly once per restored Participant, never per grant row.
- **Regression**: existing `case-services.test.ts` (which calls the now-removed `setCaseState`) is
  rewritten against `closeCase`/`reopenCase`.
