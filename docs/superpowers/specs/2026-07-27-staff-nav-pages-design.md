# Staff nav pages: Clientes, Miembros, Configuración

## Context

Three sidebar nav entries in `src/components/app-shell.tsx` point at routes with no page: `/clients`
("Clientes"), `/members` ("Miembros"), and a "Configuración" entry that is a plain `<button>` with
no `onClick` at all. This spec covers building all three, following the codebase's own convention
(`src/app/cases/page.tsx`): a Server Component that resolves the staff member via `requireStaff()`,
reads data through a `src/features/*/queries.ts` function running under RLS, and hands it to a
Client Component rendered inside `AppShell`.

Scope decision for this round: everything described here is fully real, not synthetic — no
placeholder Server Actions, no stubbed behavior pretending to work. Where a piece is genuinely out
of scope (Miembros' invite-by-email, which needs to create a real auth user and send mail — same
SMTP dependency as the Client Portal's OTP delivery), the UI says so honestly (a disabled control)
rather than wiring a button to code with no real effect.

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

**Case count correctness** — a Client can appear as a participant more than once on the same Case
(e.g. duplicate participant rows, or a data-entry mistake), and `case_participants` is the join
table, not `cases` itself. `caseCount` must be a `count(distinct case_id)` per client, computed as
a single aggregate query (one round trip for the whole directory, not one query per client) —
never `count(*)` over `case_participants` rows, which would inflate the number.

**Result cap** — pagination is deferred, but the query still caps at a fixed limit (500 clients)
so a large organization can't return an unbounded result set. Revisit if any real organization
gets close to it.

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
already being trusted. For a foreign `organizationId`, the check fails and the query returns zero
rows — never an error — so a caller cannot distinguish "that organization doesn't exist" from
"that organization exists but isn't yours." No existence leak either way.

Schema-guard checklist for this function (matching the codebase's existing SECURITY DEFINER
conventions in `tests/isolation/schema-guard.test.ts`):
- `set search_path = ''` — pinned, already covered generically by the guard's "pins search_path on
  every SECURITY DEFINER function" check (schema-guard.test.ts:80-96), which scans `app`/`public`
  dynamically. No test file change needed for this part.
- `stable` — this one IS an explicit enumerated list in the guard
  (schema-guard.test.ts:98-112, `proname in ('member_org_ids', 'granted_case_ids', 'is_org_owner')`).
  `org_members_with_email` must be added to that list, or it would silently stop being checked.
- `revoke all ... from public` + `grant execute ... to authenticated` only — no `anon` execution,
  matching `member_org_ids` / `is_org_owner`.

**Product decision on visibility (explicit, not incidental):** the Members page is a team
directory, not an admin-only screen. Any active member of the organization — owner or staff — may
read the full member list, including emails and roles. Only *mutating* actions (inviting, changing
roles, removing members — the last two out of scope for this round regardless) are owner-only.
This is why `org_members_with_email` checks `member_org_ids()` (any membership) rather than
`is_org_owner()` (ownership) — that choice is deliberate, not an oversight, and must not be
"tightened" to owner-only without a new product decision.

**Read model** — `src/features/members/queries.ts`, `getOrganizationMembers()`:
- Calls `app.org_members_with_email` with the caller's `organizationId` (from `requireStaff()` —
  never from client-submitted input; there is no form field or query param that could supply an
  organization id here).
- Returns `{ id, email, role, memberSince }[]`.

**Page** — `src/app/members/page.tsx` (Server Component), same shape as Clientes, passing
`isOwner: staff.role === 'owner'` down to the client component (this only controls the invite
control's affordance in the UI; it grants no data access by itself — the directory read above is
available to any member regardless of `isOwner`).

**Client Component** — `src/app/members/members-directory.tsx`:
- One row per member: email, role badge ("Propietario" / "Staff"), member since (formatted date).
  Visible to every viewer of the page, per the product decision above.
- "Invitar miembro" control, rendered **disabled** with a "Próximamente" badge/tooltip
  ("La invitación por correo estará disponible pronto") when `isOwner`, and not rendered at all
  when the viewer is not an owner. No modal, no click handler, no Server Action backing it in this
  round — inviting is not real yet, so nothing about the UI should imply it is. Building a
  Server Action whose only job is to return a fixed "not implemented" error is dead code with
  extra steps; the honest thing is for the control itself to say so.
  Wiring the real invite (creating an `auth.users` row via the admin API, inserting the `members`
  row, sending the invite email, and — at that point — a real Server Action) is deferred to the
  round where SMTP gets resolved.

## Configuración (`/settings`)

No new backend: `organizations.name` and `organizations.industry` are already owner-editable via
the existing `organizations_update_by_owner` RLS policy (`20260722193136_organizations_and_members.sql`).
`reminder_first_delay_days` / `reminder_interval_days` / `reminder_max_count` /
`access_retention_days` stay out of the UI — their migrations explicitly say "not surfaced in the
MVP UI," and nothing about this round changes that.

> **Correction (post-implementation):** the `actor: ActorContext` design described in this section
> and below was found during implementation to be bypassable: the `members` RLS policy is
> org-scoped (any member can read any other member's row within the organization), not row-scoped
> to the caller, so a non-owner could invoke `updateOrganization` with a fabricated
> `actor.authUserId` claiming to be the owner and the check would incorrectly trust it. The shipped
> code instead has `updateOrganization(client, input)` take **no** `actor` parameter at all —
> identity is derived via `client.auth.getUser()` (the cryptographically verified session), used
> for both the authorization check and audit attribution, so there is no caller-suppliable identity
> to spoof. `ActorContext` was removed from `src/application/errors.ts` entirely since nothing uses
> it. See `src/application/update-organization.ts` for the actual implementation.

**Authorization — explicit, three layers, none of them decorative:**
1. The use case itself re-derives the actor's role and refuses the write if it isn't `owner`
   — it does not trust a boolean the caller hands it. Concretely: `updateOrganization` takes an
   `ActorContext` (a small shared type, `{ readonly authUserId: string }`, added to
   `src/application/errors.ts` alongside `UseCaseError`/`FailureReason` — no case/grant fields,
   since nothing here is Case-scoped) and, before writing anything, queries
   `members` for `(organization_id, user_id) = (organizationId, actor.authUserId)` **through the
   same RLS-scoped `client` the caller passed in** (not the admin client) and checks
   `role === 'owner'`. If not, throws `UseCaseError('forbidden', 'Solo el propietario puede editar esta información.')`
   before touching `organizations` at all.
   ⚠️ *(This exact design was found bypassable — see correction note above.)*
2. The Server Action (`src/app/settings/actions.ts`, `updateOrganizationAction(input)`)
   independently resolves `requireStaff()`-equivalent context and checks `role === 'owner'` too,
   returning a dedicated `forbidden` `ActionResult` if not — this is reachable by direct POST, so
   it re-verifies rather than assuming the page's own gating was honored.
3. RLS (`organizations_update_by_owner`) is the floor: even if both of the above were removed or
   buggy, Postgres itself refuses the write for a non-owner. The test suite proves this
   independently (see Testing) rather than only testing the use case's own check.

`organizationId` is never accepted as client input anywhere in this chain — it comes from the
resolved staff context on the server, same as Members.

**Application layer** — `src/application/update-organization.ts`:
- `updateOrganization(client, { organizationId, name, industry }, actor: ActorContext)`: the
  authorization check above, then `parseInput` via a new Zod schema (name non-empty ≤200 chars,
  industry one of the existing CHECK-constrained values), then a plain `update` on `organizations`,
  then exactly one `logDomainEvent` call for `organization.updated` — one call total per save, even
  when both `name` and `industry` changed in the same submission, not one event per changed field.
  ⚠️ *(Correction: the shipped signature is `updateOrganization(client, input)` — no `actor`
  parameter. See the correction note under "Authorization" above.)*

**Changing industry never touches existing data.** `organizations.industry` is read by other parts
of the system only when *creating new* things (default terminology, starter Blueprints suggested
in the wizard) — per its own migration comment, it "must never branch engine behaviour." Saving a
new industry updates only the `organizations` row; it must not, and structurally cannot, cascade
into any existing Case, Blueprint, or Requirement. Because this is easy to *assume* but the
consequence of getting it wrong is invisible until much later, the UI adds a confirmation step
specifically when industry is changed (not needed for a plain name edit): a dialog stating that
existing expedientes and plantillas are unaffected, requiring an explicit confirm before the save
fires.

**Page** — `src/app/settings/page.tsx` (Server Component) + `src/app/settings/settings-form.tsx`
(Client Component):
- Shows organization name (text input) and industry (select, from the same fixed list as the
  CHECK constraint: notary/accounting/legal/insurance/hr/other, labeled in Spanish).
- If `role !== 'owner'`: both fields render read-only, with a short note ("Solo el propietario
  puede editar esta información").
- Changing the industry select triggers the confirmation dialog described above before the save
  action fires; changing only the name does not.
- Save button, inline success/error feedback via the Server Action's `ActionResult`.

**Sidebar change** — `src/components/app-shell.tsx`:
- `NavKey` gains `"settings"`.
- The `Configuración` entry moves out of the standalone `<button>` and into the `NAV` array as
  `{ key: "settings", label: "Configuración", href: "/settings", Icon: IconSettings }`, rendered
  the same way as the other four links (so it also gets active-state highlighting for free).

## Testing

- `tests/integration/clients-directory.test.ts`:
  - `getClientsDirectory` returns the caller's own clients with correct case counts, and nothing
    from another organization (reuses `buildTwoOrganizationWorld`).
  - A Client who is a participant on the same Case more than once (duplicate `case_participants`
    rows) still reports `caseCount` as the number of *distinct* Cases, not the number of
    participant rows — the regression this spec exists to prevent.
  - The result respects the initial cap (assert the query is bounded; doesn't need to actually
    create 500+ clients, just confirm the `limit` is present and honored for a small over-cap
    fixture if that's cheap, otherwise assert on the query builder call).
  - Route protection: `getClientsDirectory` (or the page-level guard it sits behind) refuses an
    unauthenticated caller — reuses the same pattern as existing RLS refusal tests (`anonClient()`
    gets nothing back), since Server Components in this codebase have no separate test harness
    beyond exercising the RLS-scoped query directly.

- `tests/integration/members-directory.test.ts`:
  - `getOrganizationMembers` returns only the caller's own organization's members with correct
    emails/roles.
  - **Cross-org non-enumeration**: calling `app.org_members_with_email` with a foreign
    `organizationId` returns zero rows, not an error — proves the security-critical check inside
    the SECURITY DEFINER function, and that existence isn't leaked either way.
  - **Anon execution denial**: `anonClient().rpc('org_members_with_email', ...)` is refused —
    proves the `revoke ... from public` / no grant to `anon` actually holds, not just that the
    migration says so.
  - **Any-member visibility**: a `staff`-role member (not just the `owner`) can read the full
    directory including other members' emails — proves the product decision (any active member
    may view) is actually implemented, not accidentally owner-gated.
  - `organizationId` is always taken from the resolved staff context, never a caller-supplied
    value — assert the query function's signature takes no organization id parameter from
    outside `requireStaff()`'s result (a type-level guarantee, but worth a comment/test noting
    intent).
  - No behavioral test needed for inviting — there is no invite behavior in this round to regress.
    A quick UI-level check that the control renders disabled for owners and is absent for staff is
    enough.

- `tests/integration/update-organization.test.ts`:
  - An owner can update name and industry in one call; `audit_events` gets exactly one
    `organization.updated` row for that call, not two.
  - A non-owner staff member's attempt is refused **twice over**: once by the use case's own
    membership-role check (derived from `client.auth.getUser()`, not a caller-suppliable
    `ActorContext` — see correction note under "Authorization" above; assert the specific
    `UseCaseError('forbidden', ...)`), and once more by
    calling the raw RLS-scoped update directly with a staff member's client, bypassing the use
    case entirely, to prove the RLS floor (`organizations_update_by_owner`) holds independently of
    any application-layer bug.
  - Updating industry does not modify any existing `cases`, `blueprints`, or `requirements` rows
    (snapshot them before/after and assert equality) — the regression this spec exists to prevent
    for "industry must never alter existing data."
  - `organizationId` passed to the use case always originates from `requireStaff()`, mirrored by
    the Server Action never accepting one from `input`.

## Out of scope (explicitly deferred)

- Staff invitation entirely — no Server Action, no use case, not even a stub. The control renders
  disabled ("Próximamente") with no backing behavior at all. Real invitation (creating
  `auth.users`, sending mail, a real Server Action) is next round, with SMTP.
- Client detail view / editing clients directly (bypassing the case wizard).
- Reminder cadence and access-retention settings in the Configuración UI.
- Role changes (promoting a member from staff to owner, or removing a member).
