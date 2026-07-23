-- Narrow document access to the Participant of the target Requirement (design.md D1).
--
-- A Client reads and uploads only for Requirements assigned to a Participant it is granted on.
-- The check is one level of indirection (document -> requirement -> participant), bounded by the
-- granted-participant set and supported by requirements(participant_id); it is not a tree-walk to
-- the tenant, which stays a direct column.

drop policy documents_select on public.documents;
drop policy documents_insert on public.documents;

create policy documents_select
  on public.documents
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or requirement_id in (
      select r.id from public.requirements r
      where r.participant_id in (select app.granted_participant_ids('view'))
    )
  );

create policy documents_insert
  on public.documents
  for insert
  to authenticated
  with check (
    organization_id in (select app.member_org_ids())
    or requirement_id in (
      select r.id from public.requirements r
      where r.participant_id in (select app.granted_participant_ids('upload'))
    )
  );

-- Reviews remain Case-scoped for the client's read (they see decisions on their own
-- requirements' documents); narrow the same way for consistency.
drop policy reviews_select on public.reviews;

create policy reviews_select
  on public.reviews
  for select
  to authenticated
  using (
    organization_id in (select app.member_org_ids())
    or document_id in (
      select d.id from public.documents d
      join public.requirements r on r.id = d.requirement_id
      where r.participant_id in (select app.granted_participant_ids('view'))
    )
  );

-- ---------------------------------------------------------------------------------------------
-- Storage: scope client object access to the Participant via the requirement in the path
-- ---------------------------------------------------------------------------------------------
--
-- Path is {org}/cases/{case}/requirements/{req}/{doc}; foldername() drops the filename, so
-- [1]=org and [5]=requirement id. Members keep org-level access on [1]; a Client now reaches an
-- object only when the requirement (folder 5) is assigned to a Participant it is granted on.

drop policy case_documents_select on storage.objects;
drop policy case_documents_insert on storage.objects;

create policy case_documents_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'case-documents'
    and (
      app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
      or app.safe_uuid((storage.foldername(name))[5]) in (
        select r.id from public.requirements r
        where r.participant_id in (select app.granted_participant_ids('view'))
      )
    )
  );

create policy case_documents_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'case-documents'
    and (
      app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
      or app.safe_uuid((storage.foldername(name))[5]) in (
        select r.id from public.requirements r
        where r.participant_id in (select app.granted_participant_ids('upload'))
      )
    )
  );
