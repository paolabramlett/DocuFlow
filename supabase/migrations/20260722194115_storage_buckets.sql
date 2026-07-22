-- Private document storage.
--
-- The object path leads with the tenant:
--   {organization_id}/cases/{case_id}/requirements/{requirement_id}/{document_id}
-- so storage policies apply the same resolvers as table policies and the two cannot disagree
-- about who may read what (design.md D10).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'case-documents',
  'case-documents',
  false,
  26214400, -- 25 MiB
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Path segments are untrusted text until proven otherwise. A hard `::uuid` cast would raise on a
-- malformed path and turn a denial into a 500; this returns null instead, and `in (select ...)`
-- against null is false — so a malformed path fails closed.
create or replace function app.safe_uuid(value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return value::uuid;
exception
  when others then
    return null;
end;
$$;

comment on function app.safe_uuid(text) is
  'Casts text to uuid, returning null instead of raising. Used to parse untrusted storage paths.';

revoke all on function app.safe_uuid(text) from public;
grant execute on function app.safe_uuid(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Object policies
-- ---------------------------------------------------------------------------------------------
--
-- foldername() drops the filename, so for the path above:
--   [1] = organization_id   [2] = 'cases'   [3] = case_id   [4] = 'requirements'   [5] = requirement_id

create policy case_documents_select
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'case-documents'
    and (
      app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
      or app.safe_uuid((storage.foldername(name))[3]) in (select app.granted_case_ids('view'))
    )
  );

-- Writing requires the `upload` permission specifically, so a view-only grant that can read an
-- object still cannot add one.
create policy case_documents_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'case-documents'
    and (
      app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
      or app.safe_uuid((storage.foldername(name))[3]) in (select app.granted_case_ids('upload'))
    )
  );

-- Members of the owning Organization manage objects. Clients never update or delete: a document
-- they replace is a new upload plus a new Review, which keeps the history intact.
create policy case_documents_update_by_member
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'case-documents'
    and app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
  )
  with check (
    bucket_id = 'case-documents'
    and app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
  );

create policy case_documents_delete_by_member
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'case-documents'
    and app.safe_uuid((storage.foldername(name))[1]) in (select app.member_org_ids())
  );
