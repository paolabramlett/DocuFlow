-- Recompute case_ready under the participant model, and forbid moving a Case between Orgs
-- (design.md D11, D8).

-- ---------------------------------------------------------------------------------------------
-- case_ready across the whole Case (design.md D11)
-- ---------------------------------------------------------------------------------------------
--
-- "Ready" counts every live Requirement of the Case — assigned and unassigned Staff-internal
-- alike — and excludes deleted and superseded ones. A single Participant finishing does not
-- complete the Case; an outstanding unassigned Requirement keeps it open. participant_ready is a
-- future notification and is deliberately not emitted here.

create or replace function app.notify_case_ready()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  outstanding_remaining integer;
begin
  if new.status = 'satisfied' and old.status is distinct from 'satisfied' then
    select count(*)
      into outstanding_remaining
      from public.requirements r
     where r.case_id = new.case_id
       and r.deleted_at is null
       and r.superseded_at is null
       and r.status <> 'satisfied'
       and r.status <> 'archived';

    if outstanding_remaining = 0 then
      insert into public.staff_notifications (organization_id, case_id, reason, target_type, target_id)
      values (new.organization_id, new.case_id, 'case_ready', 'case', new.case_id);
    end if;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- A Case can never move between Organizations (design.md D8)
-- ---------------------------------------------------------------------------------------------

create or replace function app.reject_case_org_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'a case cannot move between organizations'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function app.reject_case_org_change() is
  'Rejects any UPDATE that would change cases.organization_id.';

revoke all on function app.reject_case_org_change() from public;

create trigger cases_reject_org_change
  before update on public.cases
  for each row execute function app.reject_case_org_change();
