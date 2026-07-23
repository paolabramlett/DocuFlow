-- case_participants: the party layer between Client and grant.
--
-- A Case has one or more Participants. Each links an Organization-owned Client to the Case with a
-- descriptive role label. A grant (re-pointed in a later migration) attaches to a Participant, and
-- a Client identity sees only the Requirements assigned to the Participant it is granted on.
--
-- Deliberately NO unique on (case_id, client_id): one person can be two participants of one Case
-- when the roles are genuinely distinct (a buyer who is also a company's legal representative,
-- design.md D9). Uniqueness is on the participant id alone.

create table public.case_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  client_id uuid not null,

  -- Descriptive only. Never drives authorization (design.md D9, case-participants spec).
  role_label text not null check (length(btrim(role_label)) between 1 and 100),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Both parents carry the tenant into this row; the composite FKs make a cross-tenant
  -- participant unrepresentable (design.md D3 pattern).
  foreign key (case_id, organization_id)
    references public.cases (id, organization_id) on delete cascade,
  foreign key (client_id, organization_id)
    references public.clients (id, organization_id) on delete restrict,

  -- Needed by grants and requirements that reference a participant and must stay in the same
  -- Case and Organization.
  unique (id, organization_id),
  unique (id, case_id, organization_id)
);

create index case_participants_case_idx on public.case_participants (case_id);
create index case_participants_client_idx on public.case_participants (client_id);
create index case_participants_organization_idx on public.case_participants (organization_id);

create trigger case_participants_set_updated_at
  before update on public.case_participants
  for each row execute function app.set_updated_at();

alter table public.case_participants enable row level security;

-- Staff of the owning Organization manage participants. The Client-read clause (a Client may read
-- the participant it is granted on) is added by the grants-repoint migration, once grants
-- reference a participant — it cannot be expressed before that column exists. Staff-only until then.
create policy case_participants_select_by_member
  on public.case_participants
  for select
  to authenticated
  using (organization_id in (select app.member_org_ids()));

create policy case_participants_insert_by_member
  on public.case_participants
  for insert
  to authenticated
  with check (organization_id in (select app.member_org_ids()));

create policy case_participants_update_by_member
  on public.case_participants
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

create policy case_participants_delete_by_member
  on public.case_participants
  for delete
  to authenticated
  using (organization_id in (select app.member_org_ids()));

grant select, insert, update, delete on public.case_participants to authenticated;
grant all on public.case_participants to service_role;
