-- supabase/migrations/20260805170000_document_upload_sessions.sql
--
-- Schema for the Portal upload progress + cancel feature. See
-- docs/superpowers/specs/2026-08-05-portal-upload-progress-design.md for the full design. This
-- file only adds the table/RLS/constraints; the three RPCs and the cleanup functions are their
-- own, later-numbered migrations (dependency order, not just style).

create table public.document_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  requirement_id uuid not null,
  participant_id uuid not null,
  bucket text not null default 'case-documents',
  storage_path text not null unique,
  original_file_name text not null check (length(btrim(original_file_name)) between 1 and 500),
  declared_content_type text not null,
  declared_size_bytes bigint not null check (declared_size_bytes > 0),
  -- Recorded at prepare time as now() + 2 hours — the empirically-confirmed default TTL of the
  -- signed upload URL itself (see design spec §3). Not read by any code path yet — purely for
  -- future observability, distinguishing our own session expiry from the signed URL's own.
  signed_url_expires_at timestamptz not null,
  -- The eventual documents.id, chosen before any documents row exists. A reservation, not a
  -- reference — cannot carry a foreign key yet.
  reserved_document_id uuid not null,
  -- Filled only by finalize_document_upload, on success. Always equal to reserved_document_id
  -- when non-null — enforced below, not just a convention.
  completed_document_id uuid references public.documents (id),
  status text not null default 'pending'
    check (status in ('pending', 'finalizing', 'completed', 'cancelled', 'expired')),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_at timestamptz,

  constraint document_upload_sessions_completed_matches_reserved
    check (completed_document_id is null or completed_document_id = reserved_document_id),
  constraint document_upload_sessions_claimed_only_when_finalizing
    check ((status = 'finalizing') = (claimed_at is not null)),
  constraint document_upload_sessions_completed_only_when_completed
    check ((status = 'completed') = (completed_document_id is not null and completed_at is not null))
);

create index document_upload_sessions_cleanup_idx
  on public.document_upload_sessions (status, expires_at)
  where status in ('pending', 'finalizing');

create index document_upload_sessions_requirement_idx
  on public.document_upload_sessions (requirement_id);

alter table public.document_upload_sessions enable row level security;

-- A Participant may SEE their own sessions (scoped by an active 'upload' grant, mirroring
-- requirements' own grant-scoped policy shape). Deliberately NO insert/update/delete policy for
-- any client role, for any operation: creation goes through create_upload_session (this same
-- migration, below) and every state transition goes through the RPCs in later tasks — all
-- security definer/invoker functions that re-validate the caller's own business rules in SQL,
-- never a bare RLS check on the write itself. A client that could INSERT directly (even scoped to
-- their own participant_id) could smuggle in values create_upload_session's own validation
-- rejects — an already-satisfied requirement's id, a declared_size_bytes/content_type outside
-- this project's real limits, or a storage_path that doesn't match documentObjectPath's shape.
-- Table access from any client role is read-only; every write is RPC-mediated.
create policy document_upload_sessions_select_own
  on public.document_upload_sessions for select
  to authenticated
  using (participant_id in (select app.granted_participant_ids('upload')));

-- Grant-level enforcement mirrors the RLS policy shape above: authenticated gets ONLY select
-- (no insert/update/delete grant at all, matching there being no insert/update/delete policy) —
-- a second, independent layer, since Postgres requires both a GRANT and a permissive RLS policy
-- to allow an operation. service_role (used by every RPC's security definer execution and by
-- admin/test tooling) needs full access to actually perform writes.
grant select on public.document_upload_sessions to authenticated;
grant all on public.document_upload_sessions to service_role;

comment on table public.document_upload_sessions is
  'Tracks a Portal document upload attempt through prepare -> direct browser upload -> finalize.
   State machine: pending -> finalizing -> completed, or pending -> cancelled, or
   pending/finalizing -> expired. See design spec section 4 for the full claim/finalize race
   analysis and section 9 for why terminal rows are retained (not deleted) for 7-30 days. Every
   write to this table — including creation — is RPC-mediated (create_upload_session,
   claim_upload_session_for_finalize, finalize_document_upload, cancel_upload_session); no client
   role has an insert/update/delete RLS policy on the table itself.';

-- Creation is its own RPC, not a raw INSERT the client performs directly — this is the same
-- reasoning as every state-transition RPC below, applied to the FIRST write too. security definer
-- (not invoker): with no insert policy at all for any role, an invoker-mode function running as
-- the caller couldn't insert either — this function must run with the owning role's privilege,
-- so it re-validates everything itself rather than leaning on RLS for any part of the check.
create or replace function public.create_upload_session(
  p_requirement_id uuid,
  p_original_file_name text,
  p_declared_content_type text,
  p_declared_size_bytes bigint,
  p_storage_path text,
  p_reserved_document_id uuid,
  p_signed_url_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participant_id uuid;
  v_org_id uuid;
  v_case_id uuid;
  v_requirement_status text;
  v_session_id uuid;
begin
  -- Resolves the caller's OWN participant identity from auth.uid() via the requirement itself —
  -- exactly how app.granted_participant_ids already works — never trusting a client-supplied
  -- participant_id (this function takes none). A requirement not owned by one of the caller's
  -- own granted (upload-permission) participants matches zero rows here, so it's indistinguishable
  -- from a nonexistent requirement, same reasoning as every other RPC in this feature.
  select r.organization_id, r.case_id, r.participant_id, r.status
    into v_org_id, v_case_id, v_participant_id, v_requirement_status
  from public.requirements r
  where r.id = p_requirement_id
    and r.participant_id in (select app.granted_participant_ids('upload'));

  if v_participant_id is null then
    raise exception using errcode = 'P0001', message = 'requirement_not_found';
  end if;
  if v_requirement_status = 'satisfied' then
    raise exception using errcode = 'P0001', message = 'requirement_already_satisfied';
  end if;
  -- Re-states MAX_DOCUMENT_BYTES (25 MiB) / ALLOWED_CONTENT_TYPES (src/features/documents/
  -- schemas.ts) at the SQL layer — the same "two enforcement points on purpose" precedent this
  -- schema's own comment already establishes for storage bucket limits vs. app-level checks. If
  -- those constants ever change, this literal list must be updated in the same commit.
  if p_declared_size_bytes <= 0 or p_declared_size_bytes > 26214400 then
    raise exception using errcode = 'P0001', message = 'file_too_large';
  end if;
  if p_declared_content_type not in ('application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp') then
    raise exception using errcode = 'P0001', message = 'content_type_not_allowed';
  end if;

  insert into public.document_upload_sessions (
    organization_id, case_id, requirement_id, participant_id, storage_path,
    original_file_name, declared_content_type, declared_size_bytes,
    signed_url_expires_at, reserved_document_id, expires_at
  ) values (
    v_org_id, v_case_id, p_requirement_id, v_participant_id, p_storage_path,
    p_original_file_name, p_declared_content_type, p_declared_size_bytes,
    p_signed_url_expires_at, p_reserved_document_id, now() + interval '30 minutes'
  )
  returning id into v_session_id;

  return v_session_id;
end;
$$;

revoke all on function public.create_upload_session(uuid, text, text, bigint, text, uuid, timestamptz) from public;
grant execute on function public.create_upload_session(uuid, text, text, bigint, text, uuid, timestamptz) to authenticated;
