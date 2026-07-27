# Staff nav pages: Clientes, Miembros, Configuración

## Context

Three sidebar nav entries in `src/components/app-shell.tsx` point at routes with no page: `/clients`
("Clientes"), `/members` ("Miembros"), and a "Configuración" entry that is a plain `<button>` with
no `onClick` at all. This spec covers building all three, following the codebase's own convention
(`src/app/cases/page.tsx`): a Server Component that resolves the staff member via `requireStaff()`,
reads data through a `src/features/*/queries.ts` function running under RLS, and hands it to a
Client Component rendered inside `AppShell`.

Scope decision for this round: build what's needed today plus the shell for what's deferred.
Real backend work beyond what already exists (Miembros' invite-by-email, which needs to create a
real auth user and send mail) is explicitly deferred to a later round, same as the Client Portal's
SMTP-dependent OTP delivery. Everything else described here is fully real, not synthetic.

## Clientes (`/clients`)

**Read model** — `src/features/clients/queries.ts`, `getClientsDirectory()`:
- Reads `clients` scoped to the caller's organization (existing RLS already restricts this).
- For each client, a count of Cases they participate in, via `case_participants`.
- Returns `{ id, fullName, email, caseCount }[]`, sorted by `fullName`.

**Page** — `src/app/clients/page.tsx` (Server Component):
```
const staff = await requireStaff();
const clients = await getClientsDirectory();
return <ClientsDirectory clients={clients} account={{ name: staff.organizationName, sub: staff.email }} />;
```

**Client Component** — `src/app/clients/clients-directory.tsx`:
- Renders inside `AppShell active="clients"`.
- A search box filters the already-loaded list client-side by name or email (no server round-trip
  — organizations are not expected to have enough clients to need paginated/server-side search).
- One row per client: full name, email, case count. No actions, no detail view — a read-only
  directory. Clients are still only ever created through the "Nuevo expediente" wizard
  (`findOrCreateClient`); this page does not add a second creation path.
- Empty state: "Aún no tienes clientes. Aparecerán aquí cuando crees tu primer expediente."

## Miembros (`/members`)

**New migration** — a small SECURITY DEFINER resolver, following the exact pattern of
`app.member_org_ids()` / `app.is_org_owner()` in `20260722193136_organizations_and_members.sql`.
`members` has no email column (only `user_id` referencing `auth.users`), and `auth.users` is not
directly queryable by the `authenticated` role — so this function is the only way to surface it.

```sql
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

revoke all on function app.org_members_with_email(uuid) from public;
grant execute on function app.org_members_with_email(uuid) to authenticated;
```

The `target_organization_id in (select app.member_org_ids())` check inside the function body is
load-bearing: without it, a caller could pass any organization id and read its members' emails
through the SECURITY DEFINER bypass. It must stay inside the function, not rely on the caller
already being trusted.

**Read model** — `src/features/members/queries.ts`, `getOrganizationMembers()`:
- Calls `app.org_members_with_email` with the caller's `organizationId` (from `requireStaff()`).
- Returns `{ id, email, role, memberSince }[]`.

**Page** — `src/app/members/page.tsx` (Server Component), same shape as Clientes, passing
`isOwner: staff.role === 'owner'` down to the client component.

**Client Component** — `src/app/members/members-directory.tsx`:
- One row per member: email, role badge ("Propietario" / "Staff"), member since (formatted date).
- "Invitar miembro" button, visible only when `isOwner` — RLS already restricts the eventual
  insert to owners (`members_insert_by_owner`), but hiding the control for non-owners is better
  UX, not a security boundary.
- Clicking it opens a modal: email field with client-side validation (required, valid email
  shape), a submit button, and a cancel action. No role selector in this round — new invites are
  always `staff`; promoting to owner is a separate, later concern.
- Submitting calls `inviteMemberAction(email)` — a real, thin Server Action in
  `src/app/members/actions.ts` that exists and is wired into the UI, but its body does not yet
  create a user or send anything. It re-verifies `role === 'owner'` server-side (never trust the
  client-side gate alone) and then returns a dedicated result:
  ```ts
  return fail(new UseCaseError('unexpected', 'La invitación por correo aún no está conectada. Vuelve pronto.'));
  ```
  This mirrors the codebase's established principle of dedicated error states over generic
  failures or silent no-ops — the modal shows this message inline rather than pretending success.
  Wiring the real invite (creating an `auth.users` row via the admin API, inserting the `members`
  row, sending the invite email) is deferred to the round where SMTP gets resolved.

## Configuración (`/settings`)

No new backend: `organizations.name` and `organizations.industry` are already owner-editable via
the existing `organizations_update_by_owner` RLS policy (`20260722193136_organizations_and_members.sql`).
`reminder_first_delay_days` / `reminder_interval_days` / `reminder_max_count` /
`access_retention_days` stay out of the UI — their migrations explicitly say "not surfaced in the
MVP UI," and nothing about this round changes that.

**Application layer** — `src/application/update-organization.ts`:
- `updateOrganization(client, { organizationId, name, industry }, actorAuthUserId)`: thin use
  case, `parseInput` via a new Zod schema (name non-empty ≤200 chars, industry one of the existing
  CHECK-constrained values), then a plain `update` on `organizations`, then `logDomainEvent` for
  `organization.updated` (matching the "introduce event logging for key domain events" convention
  from earlier in this project).

**Server Action** — `src/app/settings/actions.ts`, `updateOrganizationAction(input)`: re-resolves
`requireStaff`-equivalent staff context, checks `role === 'owner'` (RLS would refuse the write
either way, but the Server Action should return a dedicated `forbidden` result rather than let a
non-owner hit a raw Postgres error), calls the use case, returns `ActionResult<null>`.

**Page** — `src/app/settings/page.tsx` (Server Component) + `src/app/settings/settings-form.tsx`
(Client Component):
- Shows organization name (text input) and industry (select, from the same fixed list as the
  CHECK constraint: notary/accounting/legal/insurance/hr/other, labeled in Spanish).
- If `role !== 'owner'`: both fields render read-only, with a short note ("Solo el propietario
  puede editar esta información").
- Save button, inline success/error feedback via the Server Action's `ActionResult`.

**Sidebar change** — `src/components/app-shell.tsx`:
- `NavKey` gains `"settings"`.
- The `Configuración` entry moves out of the standalone `<button>` and into the `NAV` array as
  `{ key: "settings", label: "Configuración", href: "/settings", Icon: IconSettings }`, rendered
  the same way as the other four links (so it also gets active-state highlighting for free).

## Testing

- `tests/integration/clients-directory.test.ts`: `getClientsDirectory` returns the caller's own
  clients with correct case counts, and nothing from another organization (reuses
  `buildTwoOrganizationWorld`).
- `tests/integration/members-directory.test.ts`: `app.org_members_with_email` / 
  `getOrganizationMembers` returns only the caller's own organization's members with correct
  emails/roles, and refuses (returns empty, not another org's rows) when passed a foreign
  `organizationId` — this is the security-critical case given the function is SECURITY DEFINER.
- `tests/integration/update-organization.test.ts`: an owner can update name/industry and the
  event is logged; a non-owner staff member's attempt is refused (both via the use case's own
  check and via RLS directly, to prove the RLS floor holds even if the use case's check were
  removed).
- No test coverage needed for `inviteMemberAction` beyond confirming it returns the dedicated
  "not connected yet" result and never touches the database — there is no real behavior yet to
  regress.

## Out of scope (explicitly deferred)

- Real staff invitation (creating `auth.users`, sending mail) — next round, with SMTP.
- Client detail view / editing clients directly (bypassing the case wizard).
- Reminder cadence and access-retention settings in the Configuración UI.
- Role changes (promoting a member from staff to owner, or removing a member).
