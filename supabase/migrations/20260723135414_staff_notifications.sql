-- staff_notifications: event-driven alerts for Staff, emitted by triggers at the moment a Case
-- needs a person (design.md D5). Distinct from reminders: these are rows the Staff UI reads, not
-- emails. Staff are logged into the product; the Client is absent and must be reached by mail.

create table public.staff_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,

  reason text not null check (reason in ('review_needed', 'case_ready')),

  -- What the notification points at. No foreign key, like audit_events: a notification about a
  -- Document should survive that Document, and carries an id plus type, never contents or a URL.
  target_type text not null check (length(btrim(target_type)) between 1 and 50),
  target_id uuid,

  -- Set when a Staff member has dealt with it. Kept rather than deleted so the record persists.
  acknowledged_at timestamptz,

  created_at timestamptz not null default now(),

  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade
);

create index staff_notifications_open_idx
  on public.staff_notifications (organization_id, created_at desc)
  where acknowledged_at is null;

create index staff_notifications_case_idx
  on public.staff_notifications (case_id, created_at desc);

alter table public.staff_notifications enable row level security;

create policy staff_notifications_select_by_member
  on public.staff_notifications
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

-- Staff acknowledge their own Organization's notifications; the trigger functions create them.
create policy staff_notifications_update_by_member
  on public.staff_notifications
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

grant select, update on public.staff_notifications to authenticated;
grant all on public.staff_notifications to service_role;

-- ---------------------------------------------------------------------------------------------
-- review_needed: a Client uploads a Document
-- ---------------------------------------------------------------------------------------------
--
-- Distinguishes a Client uploader from a Staff one. A Staff member uploading on the client's
-- behalf does not need to notify themselves (staff-notifications spec). The uploader's role is
-- read from members: absence there means the uploader is a Client acting through a grant.

create or replace function app.notify_review_needed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  uploader_is_member boolean;
begin
  select exists (
    select 1 from public.members m
    where m.user_id = new.uploaded_by_auth_user_id
      and m.organization_id = new.organization_id
  ) into uploader_is_member;

  if not uploader_is_member then
    insert into public.staff_notifications (organization_id, case_id, reason, target_type, target_id)
    values (new.organization_id, new.case_id, 'review_needed', 'document', new.id);
  end if;

  return new;
end;
$$;

comment on function app.notify_review_needed() is
  'Creates a review_needed staff notification when a Client (non-member) uploads a Document.';

revoke all on function app.notify_review_needed() from public;

create trigger documents_notify_review_needed
  after insert on public.documents
  for each row execute function app.notify_review_needed();

-- ---------------------------------------------------------------------------------------------
-- case_ready: the last outstanding requirement becomes satisfied
-- ---------------------------------------------------------------------------------------------
--
-- Edge-triggered on the transition to fully-satisfied (design.md D6): fires only when no
-- outstanding, non-deleted requirement remains after this change, so one notification per
-- Case-becoming-ready rather than one per approval.

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
       and r.status <> 'satisfied';

    if outstanding_remaining = 0 then
      insert into public.staff_notifications (organization_id, case_id, reason, target_type, target_id)
      values (new.organization_id, new.case_id, 'case_ready', 'case', new.case_id);
    end if;
  end if;

  return new;
end;
$$;

comment on function app.notify_case_ready() is
  'Creates a case_ready staff notification when a Case reaches zero outstanding requirements.';

revoke all on function app.notify_case_ready() from public;

create trigger requirements_notify_case_ready
  after update of status on public.requirements
  for each row execute function app.notify_case_ready();
