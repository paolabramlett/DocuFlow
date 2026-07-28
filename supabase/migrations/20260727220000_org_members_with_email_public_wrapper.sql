-- Public wrapper for org_members_with_email to make it callable via RPC.
-- The actual security logic is in app.org_members_with_email (SECURITY DEFINER).
-- This wrapper exists only to bridge the RPC surface.

create or replace function public.org_members_with_email(target_organization_id uuid)
returns table (id uuid, user_id uuid, email text, role text, created_at timestamptz)
language sql
stable
as $$
  select id, user_id, email, role, created_at
  from app.org_members_with_email(target_organization_id)
$$;

revoke all on function public.org_members_with_email(uuid) from public;
grant execute on function public.org_members_with_email(uuid) to authenticated;
