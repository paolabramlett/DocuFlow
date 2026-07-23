-- Re-point Case Access grants at Participants (design.md D1).
--
-- The subject of a grant becomes the Participant, not a (client, case) pair. The Participant
-- carries the client, so grants.client_id is dropped as an authority. A new resolver answers
-- "which participants is the caller granted on", and granted_case_ids is redefined in terms of it,
-- so there is still exactly one definition of an active grant.
--
-- Applied against an empty grants table (fresh reset), so the NOT NULL column is added directly.

-- ---------------------------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------------------------

alter table public.case_access_grants
  add column participant_id uuid not null;

-- The composite FK ties the grant to a Participant of the SAME Case and Organization, so a grant
-- can never point at a participant of another Case.
alter table public.case_access_grants
  add constraint case_access_grants_participant_fk
  foreign key (participant_id, case_id, organization_id)
  references public.case_participants (id, case_id, organization_id) on delete cascade;

-- The Participant is now the single source for the client; drop the redundant grant->client link.
alter table public.case_access_grants
  drop constraint case_access_grants_client_id_organization_id_fkey;
alter table public.case_access_grants
  drop column client_id;

create index grants_participant_active_idx
  on public.case_access_grants (participant_id, expires_at)
  where verified_at is not null and revoked_at is null;

-- ---------------------------------------------------------------------------------------------
-- Resolvers (design.md D1, D2)
-- ---------------------------------------------------------------------------------------------

-- SECURITY-CRITICAL. The base activity resolver, now keyed to Participants. Same rules as the
-- others: no dynamic SQL, pinned search_path, STABLE, one question. This is the single definition
-- of an active grant; everything else routes through it.
create or replace function app.granted_participant_ids(min_permission text default 'view')
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select g.participant_id
  from public.case_access_grants g
  where g.auth_user_id = (select auth.uid())
    and g.verified_at is not null
    and g.revoked_at is null
    and g.expires_at is not null
    and g.expires_at > now()
    and case min_permission
          when 'view' then g.permission in ('view', 'upload')
          when 'upload' then g.permission = 'upload'
          else false
        end
$$;

comment on function app.granted_participant_ids(text) is
  'SECURITY-CRITICAL. Participants the current user holds an active grant on, at or above min_permission.';

revoke all on function app.granted_participant_ids(text) from public;
grant execute on function app.granted_participant_ids(text) to authenticated;

-- Redefined in terms of the participant resolver: a Case is visible to a Client if they hold an
-- active grant on any of its Participants. No second activity predicate.
create or replace function app.granted_case_ids(min_permission text default 'view')
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.case_id
  from public.case_participants p
  where p.id in (select app.granted_participant_ids(min_permission))
$$;

comment on function app.granted_case_ids(text) is
  'SECURITY-CRITICAL. Cases the current user holds an active grant on, derived via granted_participant_ids.';

-- ---------------------------------------------------------------------------------------------
-- Participant read: add the client clause now that grants reference participants
-- ---------------------------------------------------------------------------------------------

drop policy case_participants_select_by_member on public.case_participants;

create policy case_participants_select
  on public.case_participants
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or id in (select app.granted_participant_ids('view'))
  );
