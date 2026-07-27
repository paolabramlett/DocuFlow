-- Surfaces a Member's email for the Miembros directory page. `members` has no email column
-- (only `user_id` referencing `auth.users`), and `auth.users` is not directly queryable by the
-- `authenticated` role — this SECURITY DEFINER function is the only way to bridge that, matching
-- the existing app.member_org_ids() / app.is_org_owner() pattern
-- (20260722193136_organizations_and_members.sql).
--
-- Product decision (not incidental): any active member of the organization may read the full
-- directory, including other members' emails — this is a team directory, not an admin screen.
-- Only mutating actions (inviting, out of scope this round) are owner-only. That is why this
-- checks member_org_ids() (any membership) rather than is_org_owner() (ownership).
create or replace function app.org_members_with_email(target_organization_id uuid)
returns table (id uuid, user_id uuid, email text, role text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.user_id, u.email, m.role, m.created_at
  from public.members m
  join auth.users u on u.id = m.user_id
  where target_organization_id in (select app.member_org_ids())
    and m.organization_id = target_organization_id
  order by m.created_at asc
$$;

comment on function app.org_members_with_email(uuid) is
  'SECURITY-CRITICAL. Members of target_organization_id with email, for the caller only if they
   belong to that organization. Returns zero rows (never an error) for a foreign organization id,
   so existence is never leaked either way.';

-- Same execute boundary as member_org_ids() / is_org_owner(): authenticated only, never anon.
revoke all on function app.org_members_with_email(uuid) from public;
grant execute on function app.org_members_with_email(uuid) to authenticated;
