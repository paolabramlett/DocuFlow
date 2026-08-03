-- supabase/migrations/20260803150300_case_closure_grant_trigger.sql
--
-- Generalizes the existing completion-only downgrade trigger to both terminal states, and
-- corrects its grant-activity predicate to match the one canonical definition used everywhere
-- else (app.granted_participant_ids: verified_at is not null and revoked_at is null and
-- expires_at > now()). The prior version used only `revoked_at is null`, which would have
-- "downgraded" (and given a brand-new expires_at) a grant that had already expired — effectively
-- reviving it.

drop trigger cases_downgrade_grants_on_completion on public.cases;
drop function app.downgrade_grants_on_completion();

create or replace function app.downgrade_grants_on_closure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  retention_days integer;
begin
  if new.state in ('completed', 'cancelled') and old.state = 'open' then
    select o.access_retention_days
      into retention_days
      from public.organizations o
     where o.id = new.organization_id;

    update public.case_access_grants g
       set permission_before_closure = g.permission,
           permission = 'view',
           expires_at = now() + make_interval(days => retention_days)
     where g.case_id = new.id
       and g.verified_at is not null
       and g.revoked_at is null
       and g.expires_at > now();
  end if;

  return new;
end;
$$;

comment on function app.downgrade_grants_on_closure() is
  'On Case entering a terminal state (completed/cancelled) from open, downgrades active grants to
   view for the Organization retention window, remembering each one''s prior permission.';

revoke all on function app.downgrade_grants_on_closure() from public;

create trigger cases_downgrade_grants_on_closure
  after update of state on public.cases
  for each row execute function app.downgrade_grants_on_closure();
