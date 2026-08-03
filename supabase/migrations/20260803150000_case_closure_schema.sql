-- supabase/migrations/20260803150000_case_closure_schema.sql
--
-- Schema for Case closure (complete/cancel) and reopening. See
-- docs/superpowers/specs/2026-08-03-case-closure-design.md for the full design. This file only
-- adds columns/constraints; close_case, reopen_case, and the trigger swap are their own,
-- later-numbered migration files (dependency order, not just style).

-- ---------------------------------------------------------------------------------------------
-- cases: completed_at -> closed_at, now marking entry into EITHER terminal state
-- ---------------------------------------------------------------------------------------------

alter table public.cases rename column completed_at to closed_at;

alter table public.cases
  add column closed_by_auth_user_id uuid references auth.users (id) on delete set null,
  add column client_closing_note text;

-- Preflight/backfill: the OLD constraint only required completed_at for state = 'completed', so a
-- pre-existing 'cancelled' Case (if any) may have closed_at (post-rename) still null. The new
-- coherence constraint below would reject the migration outright on such a row. There is no better
-- source for "when this was cancelled" than updated_at (no history table exists) — a deliberate,
-- documented approximation, not a guess about what data exists today.
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

comment on column public.cases.closed_at is
  'Set on entry to completed or cancelled; cleared on reopen. Renamed from completed_at.';
comment on column public.cases.client_closing_note is
  'Visible to the Client (Portal + closure email). Required when state = cancelled. Never an internal-only note.';

-- ---------------------------------------------------------------------------------------------
-- organizations: canonical duration for a restored grant's new active window after reopening
-- ---------------------------------------------------------------------------------------------
--
-- Deliberately a DIFFERENT knob from access_retention_days: that one governs the read-only window
-- after closing; this one governs the active window after reopening. Same shape/range as
-- access_retention_days (supabase/migrations/20260722193136_organizations_and_members.sql) so a
-- trigger reads this instead of a bare number.

alter table public.organizations
  add column grant_reactivation_days integer not null default 90
    check (grant_reactivation_days between 1 and 3650);

-- ---------------------------------------------------------------------------------------------
-- case_access_grants: the permission captured just before downgrade, for exact restoration
-- ---------------------------------------------------------------------------------------------

alter table public.case_access_grants
  add column permission_before_closure text
    check (permission_before_closure is null or permission_before_closure in ('upload', 'view', 'none'));

comment on column public.case_access_grants.permission_before_closure is
  'The permission value at the moment this grant was first downgraded on Case closure. Restored
   verbatim on reopen when the grant is still active; cleared on every reopen regardless.';
