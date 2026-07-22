-- Documents and Reviews: the fulfillment side of a `document` Requirement.
--
-- Fulfillment that needs relational integrity gets its own table rather than living in the
-- Requirement's jsonb config (design.md D7). A future `payment` type would add its own table the
-- same way; `confirmation` would not need one.

-- Lets a Document tie itself to its Requirement, its Case, and its tenant in a single composite
-- key, so none of the three can disagree.
alter table public.requirements
  add constraint requirements_id_case_organization_key
  unique (id, case_id, organization_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  requirement_id uuid not null,

  -- Built by one server module (design.md D10). Unique because two Documents pointing at one
  -- object would make deletion ambiguous.
  storage_path text not null unique check (length(storage_path) between 1 and 1024),

  file_name text not null check (length(btrim(file_name)) between 1 and 500),
  content_type text not null check (length(content_type) between 1 and 255),
  size_bytes bigint not null check (size_bytes > 0),

  uploaded_by_auth_user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (requirement_id, case_id, organization_id)
    references public.requirements (id, case_id, organization_id) on delete cascade,

  unique (id, organization_id)
);

create index documents_requirement_id_idx on public.documents (requirement_id);
create index documents_case_id_idx on public.documents (case_id);
create index documents_organization_id_idx on public.documents (organization_id);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function app.set_updated_at();

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  document_id uuid not null,
  case_id uuid not null,

  decision text not null check (decision in ('approved', 'rejected')),

  -- Visible to the Client on rejection, so they know what to send instead.
  reason text check (length(reason) <= 2000),

  reviewed_by_auth_user_id uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),

  foreign key (document_id, organization_id)
    references public.documents (id, organization_id) on delete cascade
);

create index reviews_document_id_idx on public.reviews (document_id);
create index reviews_case_id_idx on public.reviews (case_id);

-- ---------------------------------------------------------------------------------------------
-- A Review decision moves its Requirement
-- ---------------------------------------------------------------------------------------------
--
-- Approval satisfies the Requirement; rejection returns it to outstanding so a replacement
-- upload is accepted. Prior Reviews are never touched, so the full history stays retrievable
-- (document-review spec).

create or replace function app.apply_review_to_requirement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_requirement_id uuid;
begin
  select d.requirement_id
    into target_requirement_id
    from public.documents d
   where d.id = new.document_id;

  update public.requirements r
     set status = case when new.decision = 'approved' then 'satisfied' else 'outstanding' end
   where r.id = target_requirement_id;

  return new;
end;
$$;

revoke all on function app.apply_review_to_requirement() from public;

create trigger reviews_apply_to_requirement
  after insert on public.reviews
  for each row execute function app.apply_review_to_requirement();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.documents enable row level security;
alter table public.reviews enable row level security;

-- Documents -------------------------------------------------------------------------------------

create policy documents_select
  on public.documents
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or case_id in (select app.granted_case_ids('view'))
  );

-- Upload needs the `upload` permission specifically. A view-only grant reaches the first clause
-- of the select policy but not this one.
create policy documents_insert
  on public.documents
  for insert
  to authenticated
  with check (
    organization_id in (select app.member_org_ids())
    or case_id in (select app.granted_case_ids('upload'))
  );

create policy documents_update_by_member
  on public.documents
  for update
  to authenticated
  using (organization_id in (select app.member_org_ids()))
  with check (organization_id in (select app.member_org_ids()));

create policy documents_delete_by_member
  on public.documents
  for delete
  to authenticated
  using (organization_id in (select app.member_org_ids()));

-- Reviews ---------------------------------------------------------------------------------------
--
-- Clients read decisions on their own Case so a rejection reason reaches them. They never write
-- one: there is no insert, update, or delete policy admitting a grant.

create policy reviews_select
  on public.reviews
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or case_id in (select app.granted_case_ids('view'))
  );

create policy reviews_insert_by_member
  on public.reviews
  for insert
  to authenticated
  with check (organization_id in (select app.member_org_ids()));

grant select, insert, update, delete on public.documents to authenticated;
grant select, insert on public.reviews to authenticated;
grant all on public.documents to service_role;
grant all on public.reviews to service_role;
