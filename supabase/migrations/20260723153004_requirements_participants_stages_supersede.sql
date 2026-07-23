-- Requirements gain participant assignment, stage placement, and supersession, and their client
-- RLS narrows from whole-Case to per-Participant (design.md D1, D2, D7).

-- ---------------------------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------------------------

alter table public.requirements
  -- Null = Case-level, Staff-only. Never a stand-in for "shared with everyone" (design.md D2).
  add column participant_id uuid,
  add column stage_id uuid,
  -- Supersession, recorded with explicit fields distinct from a manual archive (design.md D7).
  add column superseded_at timestamptz,
  add column superseded_by_requirement_id uuid;

-- A requirement's participant and stage must live in the same Case and Organization.
alter table public.requirements
  add constraint requirements_participant_fk
  foreign key (participant_id, case_id, organization_id)
  references public.case_participants (id, case_id, organization_id) on delete set null;

alter table public.requirements
  add constraint requirements_stage_fk
  foreign key (stage_id, case_id, organization_id)
  references public.case_stages (id, case_id, organization_id) on delete set null;

-- The successor is another Requirement of the same Case (composite FK), never itself.
alter table public.requirements
  add constraint requirements_superseded_by_fk
  foreign key (superseded_by_requirement_id, case_id, organization_id)
  references public.requirements (id, case_id, organization_id) on delete set null;

alter table public.requirements
  add constraint requirements_no_self_supersede
  check (superseded_by_requirement_id is distinct from id);

-- Manual archive is a distinct state from being superseded; both can coexist as concepts, so the
-- status set gains 'archived' while supersession is tracked by the pointer above.
alter table public.requirements
  drop constraint requirements_status_check;
alter table public.requirements
  add constraint requirements_status_check
  check (status in ('outstanding', 'satisfied', 'archived'));

create index requirements_participant_idx
  on public.requirements (participant_id)
  where participant_id is not null and deleted_at is null;

create index requirements_stage_idx
  on public.requirements (stage_id)
  where stage_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Client RLS narrows to the Participant (design.md D1)
-- ---------------------------------------------------------------------------------------------
--
-- Was: a Client saw any Requirement of a Case they held a grant on.
-- Now: a Client sees only Requirements assigned to a Participant they are granted on. Unassigned
-- (participant_id null) is never in the set, so Case-level Requirements are Staff-only.

drop policy requirements_select on public.requirements;

create policy requirements_select
  on public.requirements
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or participant_id in (select app.granted_participant_ids('view'))
  );

-- The active-requirements view excludes superseded/archived alongside deleted, so the "live"
-- set is defined in one place. Dropped and recreated (not replaced) because the column list
-- changes shape — CREATE OR REPLACE can only append columns.
drop view public.active_requirements;
create view public.active_requirements
with (security_invoker = true)
as
select
  id, organization_id, case_id, participant_id, stage_id,
  type, label, instructions, position, config, status,
  created_at, updated_at
from public.requirements
where deleted_at is null
  and superseded_at is null
  and status <> 'archived';

grant select on public.active_requirements to authenticated;
grant all on public.active_requirements to service_role;
