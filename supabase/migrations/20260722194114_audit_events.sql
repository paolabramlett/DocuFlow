-- Audit events: append-only, and deliberately loosely coupled to what they describe.
--
-- Events must outlive their subjects. A foreign key to a Requirement or Document would either
-- block that row's deletion or cascade the evidence away with it, so targets are recorded as a
-- type plus an id with no referential constraint, alongside a metadata snapshot that keeps the
-- event readable after the subject is gone (design.md D8).

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),

  -- The one real foreign key: RLS scoping depends on it.
  organization_id uuid not null references public.organizations (id) on delete cascade,

  -- Convenience scope for reading a single Case's history. No FK, for the same reason as target.
  case_id uuid,

  action text not null check (length(btrim(action)) between 1 and 100),

  target_type text not null check (length(btrim(target_type)) between 1 and 50),
  target_id uuid,

  actor_kind text not null check (actor_kind in ('member', 'client', 'system')),
  actor_auth_user_id uuid,
  actor_grant_id uuid,

  -- Identifiers and metadata only. Never OTP codes, session tokens, signed URLs, or file
  -- contents (audit-trail spec).
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),

  created_at timestamptz not null default now(),

  -- A system actor has no user; a member or client actor must be attributable.
  constraint audit_actor_is_attributable check (
    (actor_kind = 'system' and actor_auth_user_id is null)
    or (actor_kind in ('member', 'client') and actor_auth_user_id is not null)
  ),

  -- Only a client acts through a grant.
  constraint audit_grant_only_for_client check (
    actor_grant_id is null or actor_kind = 'client'
  )
);

create index audit_events_organization_created_idx
  on public.audit_events (organization_id, created_at desc);

create index audit_events_case_created_idx
  on public.audit_events (case_id, created_at desc)
  where case_id is not null;

create index audit_events_target_idx
  on public.audit_events (target_type, target_id)
  where target_id is not null;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.audit_events enable row level security;

-- Members of the owning Organization read the trail. Clients never do: there is no policy
-- admitting a grant, and RLS denies by default.
create policy audit_events_select_by_member
  on public.audit_events
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

-- Events may be recorded for any Case the actor can legitimately act on — a Client uploading a
-- Document writes an event in the Organization that granted them access, without being a Member
-- of it.
create policy audit_events_insert
  on public.audit_events
  for insert
  to authenticated
  with check (
    organization_id in (select app.member_org_ids())
    or case_id in (select app.granted_case_ids('view'))
  );

-- No UPDATE policy and no DELETE policy. RLS denies by default, so their absence is already a
-- denial; the revoke below is the second lock, so a future policy added by mistake still cannot
-- grant a privilege the role does not hold.

grant select, insert on public.audit_events to authenticated;
revoke update, delete on public.audit_events from authenticated, anon;

grant select, insert on public.audit_events to service_role;
revoke update, delete on public.audit_events from service_role;
