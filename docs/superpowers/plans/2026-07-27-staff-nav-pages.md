# Staff Nav Pages (Clientes, Miembros, Configuración) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build real pages behind the three dead sidebar links (`/clients`, `/members`, `/settings`), replacing 404s and a no-op button with working, RLS-backed screens.

**Architecture:** Each page follows the existing `/cases` convention exactly: a Server Component resolves the staff member via `requireStaff()`, reads data through a `src/features/*/queries.ts` function that takes an explicit RLS-scoped `DbClient` (so it's directly testable, the same way `getPortalCase` already is — not the untestable `createClient()`-inside-the-function style `getWorkspaceCases` uses), and hands the result to a Client Component rendered inside `AppShell`.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres/Auth), Zod, Vitest, TypeScript.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-staff-nav-pages-design.md` — every task below implements one piece of it; read it if anything here is ambiguous.
- No placeholder Server Actions. The Miembros invite control ships **disabled**, with no backing action at all — do not create `src/app/members/actions.ts` in this plan.
- `organizationId` is never accepted as client input anywhere in this feature — it always comes from `requireStaff()` / `getStaffContext()` on the server.
- Files under `src/app/**` use double-quoted strings (matches `src/app/cases/actions.ts`, `src/app/cases/page.tsx`). Files under `src/features/**` and `src/application/**` use single-quoted strings (matches `src/features/case-access/invitations.ts`, `src/application/client-portal.ts`). Match whichever directory a new file lives in.
- Local Supabase stack must be running for every integration test in this plan: `npm run db:start` (idempotent if already running), then `npm run db:env` if `.env.local` is stale.
- After Task 1's migration, regenerate types: `npm run db:types`.
- Run `npm run lint` and `npm run typecheck` at the end of every task that touches TypeScript.

---

### Task 1: `org_members_with_email` migration + schema-guard update

**Files:**
- Create: `supabase/migrations/20260727210000_org_members_with_email.sql`
- Modify: `tests/isolation/schema-guard.test.ts:98-112` (the STABLE-resolvers enumerated list)

**Interfaces:**
- Produces: Postgres RPC `org_members_with_email(target_organization_id uuid) returns table (id uuid, user_id uuid, email text, role text, created_at timestamptz)`, callable via `client.rpc('org_members_with_email', { target_organization_id })`. Task 4 depends on this.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260727210000_org_members_with_email.sql

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
```

- [ ] **Step 2: Apply it locally and regenerate types**

```bash
npm run db:reset
npm run db:types
```
Expected: reset reports the new migration applied (`Applying migration 20260727210000_org_members_with_email.sql...`); `git diff src/types/database.ts` shows a new `org_members_with_email` entry under `Functions`.

- [ ] **Step 3: Add the function to the schema guard's STABLE check**

In `tests/isolation/schema-guard.test.ts`, find:
```ts
  it('marks the authorization resolvers STABLE so they evaluate once per statement', async () => {
    const { rows } = await db.query<{ proname: string; provolatile: string }>(`
      select p.proname, p.provolatile
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in ('member_org_ids', 'granted_case_ids', 'is_org_owner')
    `);

    expect(rows).toHaveLength(3);
```
Change to:
```ts
  it('marks the authorization resolvers STABLE so they evaluate once per statement', async () => {
    const { rows } = await db.query<{ proname: string; provolatile: string }>(`
      select p.proname, p.provolatile
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
        and p.proname in ('member_org_ids', 'granted_case_ids', 'is_org_owner', 'org_members_with_email')
    `);

    expect(rows).toHaveLength(4);
```

- [ ] **Step 4: Run the schema guard suite**

```bash
npx vitest run tests/isolation/schema-guard.test.ts
```
Expected: all tests pass, including the updated STABLE check (now expecting 4 rows).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260727210000_org_members_with_email.sql src/types/database.ts tests/isolation/schema-guard.test.ts
git commit -m "Add org_members_with_email resolver for the Miembros directory"
```

---

### Task 2: Clients directory read model

**Files:**
- Create: `src/features/clients/queries.ts`
- Test: `tests/integration/clients-directory.test.ts`

**Interfaces:**
- Consumes: `buildOrganizationWorld`, `buildTwoOrganizationWorld`, `addParticipant` from `tests/helpers/fixtures.ts`; `anonClient` from `tests/helpers/clients.ts`.
- Produces: `getClientsDirectory(client: DbClient, organizationId: string): Promise<ClientDirectoryRow[]>` and `interface ClientDirectoryRow { readonly id: string; readonly fullName: string; readonly email: string; readonly caseCount: number }`. Task 3 depends on this.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/clients-directory.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anonClient } from '../helpers/clients';
import { addParticipant, buildOrganizationWorld, buildTwoOrganizationWorld } from '../helpers/fixtures';
import { getClientsDirectory } from '@/features/clients/queries';

describe('getClientsDirectory', () => {
  it("returns the caller's own clients with a distinct case count", async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Directorio',
      industry: 'notary',
      clientEmail: `primary-${randomUUID()}@example.test`,
    });

    const rows = await getClientsDirectory(world.staff.client, world.organizationId);
    const primary = rows.find((r) => r.id === world.clientId);

    expect(primary).toBeDefined();
    expect(primary?.email).toBe(world.clientEmail);
    expect(primary?.caseCount).toBe(1);
  });

  it('counts distinct Cases, not participant rows, when a Client is added twice to the same Case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Duplicado',
      industry: 'notary',
      clientEmail: `dup-${randomUUID()}@example.test`,
    });

    // A second participant row for the SAME client on the SAME case — no unique constraint
    // prevents this (case_participants has none on (case_id, client_id)). Before the fix this
    // would inflate caseCount to 2 for a Client on only one Case.
    const { error } = await world.staff.client.from('case_participants').insert({
      organization_id: world.organizationId,
      case_id: world.caseId,
      client_id: world.clientId,
      role_label: 'Segundo rol',
    });
    expect(error).toBeNull();

    const rows = await getClientsDirectory(world.staff.client, world.organizationId);
    const primary = rows.find((r) => r.id === world.clientId);

    expect(primary?.caseCount).toBe(1);
  });

  it('never returns another organization\'s clients', async () => {
    const { a, b } = await buildTwoOrganizationWorld();

    const rowsForA = await getClientsDirectory(a.staff.client, a.organizationId);
    const rowsForB = await getClientsDirectory(b.staff.client, b.organizationId);

    expect(rowsForA.some((r) => r.id === b.clientId)).toBe(false);
    expect(rowsForB.some((r) => r.id === a.clientId)).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Anon',
      industry: 'notary',
      clientEmail: `anon-${randomUUID()}@example.test`,
    });

    const rows = await getClientsDirectory(anonClient(), world.organizationId);
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/clients-directory.test.ts
```
Expected: FAIL — `Cannot find module '@/features/clients/queries'` (or similar), since the file doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/clients/queries.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

export interface ClientDirectoryRow {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly caseCount: number;
}

interface RawClientRow {
  id: string;
  full_name: string;
  email: string;
  case_participants: { case_id: string }[] | null;
}

/**
 * The Clientes directory: every Client in the caller's Organization, with how many distinct
 * Cases each one participates in.
 *
 * One round trip for the whole directory — `case_participants` is embedded per Client rather
 * than queried separately, and `caseCount` is a distinct count over `case_id` computed here in
 * JS, not `case_participants.length`. A Client can appear on the same Case more than once (no
 * unique constraint prevents a duplicate participant row), so counting rows instead of distinct
 * Cases would overstate how many Cases a Client is actually part of.
 *
 * `organizationId` always comes from the caller's own resolved staff context
 * (`requireStaff()`/`getStaffContext()`), never from client input — RLS (`clients_select_own_org`)
 * enforces this independently regardless, so a foreign id here just yields nothing back.
 */
export async function getClientsDirectory(
  client: DbClient,
  organizationId: string,
): Promise<ClientDirectoryRow[]> {
  const { data, error } = await client
    .from('clients')
    .select('id, full_name, email, case_participants(case_id)')
    .eq('organization_id', organizationId)
    .order('full_name')
    .limit(500);

  if (error) throw new Error(`getClientsDirectory: ${error.message}`);

  return ((data ?? []) as RawClientRow[]).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    caseCount: new Set((row.case_participants ?? []).map((p) => p.case_id)).size,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/clients-directory.test.ts
```
Expected: PASS, all 4 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/clients/queries.ts tests/integration/clients-directory.test.ts
git commit -m "Add getClientsDirectory read model with distinct case counts"
```

---

### Task 3: Clientes page

**Files:**
- Create: `src/app/clients/page.tsx`
- Create: `src/app/clients/clients-directory.tsx`
- Modify: `src/components/app-shell.tsx` (no change needed yet — `clients` is already a valid `NavKey` and nav entry; this task just makes the route real)

**Interfaces:**
- Consumes: `requireStaff` from `@/features/auth/context`; `createClient` from `@/lib/supabase/server`; `getClientsDirectory`, `ClientDirectoryRow` from Task 2; `AppShell` from `@/components/app-shell`; `IconSearch` from `@/components/icons`.

- [ ] **Step 1: Write the Server Component**

```tsx
// src/app/clients/page.tsx
/*
 * Clientes — Server Component. A read-only directory: Clients are still only ever created
 * through the "Nuevo expediente" wizard (findOrCreateClient); this page adds no second path.
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getClientsDirectory } from "@/features/clients/queries";
import { ClientsDirectory } from "./clients-directory";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const clients = await getClientsDirectory(supabase, staff.organizationId);

  return (
    <ClientsDirectory
      clients={clients}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
```

- [ ] **Step 2: Write the Client Component**

```tsx
// src/app/clients/clients-directory.tsx
"use client";

import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconSearch } from "@/components/icons";
import type { ClientDirectoryRow } from "@/features/clients/queries";

export function ClientsDirectory({
  clients,
  account,
}: {
  clients: ClientDirectoryRow[];
  account: ShellAccount;
}) {
  const [query, setQuery] = useState("");

  const filtered = clients.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return c.fullName.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
  });

  return (
    <AppShell active="clients" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <div className="relative w-full max-w-sm">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar clientes…"
            className="w-full rounded-input border border-border bg-app-bg py-2 pl-9 pr-3 text-sm text-text-primary outline-none transition-colors placeholder:text-text-secondary focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">Clientes</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Directorio de clientes de tu organización. Se crean automáticamente al agregarlos a un
            expediente nuevo.
          </p>
        </div>

        {clients.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Aún no tienes clientes. Aparecerán aquí cuando crees tu primer expediente.
          </p>
        ) : (
          <div className="overflow-hidden rounded-card border border-border bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-app-bg text-xs font-semibold uppercase tracking-wider text-text-secondary">
                <tr>
                  <th className="px-5 py-3">Nombre</th>
                  <th className="px-5 py-3">Correo</th>
                  <th className="px-5 py-3">Expedientes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((c) => (
                  <tr key={c.id}>
                    <td className="px-5 py-3 font-medium text-text-primary">{c.fullName}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.email}</td>
                    <td className="px-5 py-3 text-text-secondary">{c.caseCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
```

`ShellAccount` is already exported from `src/components/app-shell.tsx` — no change needed there for this import to typecheck.

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 4: Manual verification**

```bash
npm run db:start
npm run dev
```
Log in as `staff@docuflow.mx` / `docuflow-demo-2026` (seed first with `npm run db:seed` if the local DB is empty), navigate to `/clients`, confirm the directory renders with real seeded clients and correct case counts, and that the search box filters by name/email.

- [ ] **Step 5: Commit**

```bash
git add src/app/clients/page.tsx src/app/clients/clients-directory.tsx src/components/app-shell.tsx
git commit -m "Add the Clientes directory page"
```

---

### Task 4: Members directory read model

**Files:**
- Create: `src/features/members/queries.ts`
- Test: `tests/integration/members-directory.test.ts`

**Interfaces:**
- Consumes: `org_members_with_email` RPC from Task 1; `buildOrganizationWorld`, `buildTwoOrganizationWorld` from fixtures; `anonClient` from clients helper.
- Produces: `getOrganizationMembers(client: DbClient, organizationId: string): Promise<MemberDirectoryRow[]>` and `interface MemberDirectoryRow { readonly id: string; readonly email: string; readonly role: 'owner' | 'staff'; readonly memberSince: string }`. Task 5 depends on this.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/members-directory.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anonClient } from '../helpers/clients';
import { buildOrganizationWorld, buildTwoOrganizationWorld } from '../helpers/fixtures';
import { getOrganizationMembers } from '@/features/members/queries';

describe('getOrganizationMembers', () => {
  it('returns the caller\'s own organization members with email and role', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Miembros',
      industry: 'notary',
      clientEmail: `members-${randomUUID()}@example.test`,
    });

    const rows = await getOrganizationMembers(world.owner.client, world.organizationId);
    const roles = rows.map((r) => r.role).sort();

    expect(rows.map((r) => r.email)).toEqual(
      expect.arrayContaining([world.owner.email, world.staff.email]),
    );
    expect(roles).toEqual(['owner', 'staff']);
  });

  it('lets any active member view the directory, not only the owner', async () => {
    // world.staff (from buildOrganizationWorld) is role='staff', never the owner — this is the
    // product decision under test: viewing is not owner-gated, only inviting would be.
    const world = await buildOrganizationWorld({
      name: 'Notaría Cualquiera',
      industry: 'notary',
      clientEmail: `anyview-${randomUUID()}@example.test`,
    });

    const rows = await getOrganizationMembers(world.staff.client, world.organizationId);

    expect(rows.map((r) => r.email)).toContain(world.owner.email);
  });

  it('returns zero rows for a foreign organization id, never an error', async () => {
    const { a, b } = await buildTwoOrganizationWorld();

    const rows = await getOrganizationMembers(a.owner.client, b.organizationId);

    expect(rows).toEqual([]);
  });

  it('refuses anon execution of the underlying RPC', async () => {
    const { error } = await anonClient().rpc('org_members_with_email', {
      target_organization_id: '00000000-0000-0000-0000-000000000000',
    });

    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/members-directory.test.ts
```
Expected: FAIL — `Cannot find module '@/features/members/queries'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/members/queries.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

type DbClient = SupabaseClient<Database>;

export interface MemberDirectoryRow {
  readonly id: string;
  readonly email: string;
  readonly role: 'owner' | 'staff';
  readonly memberSince: string;
}

/**
 * The Miembros directory: every active Member of the caller's Organization, with email and role.
 *
 * Product decision: any active Member may read this, not only the owner — a team directory, not
 * an admin screen. Delegates to app.org_members_with_email, the only way to reach auth.users'
 * email from the authenticated role. That function re-checks membership itself
 * (target_organization_id in member_org_ids()); a foreign organizationId here returns zero rows,
 * not an error.
 */
export async function getOrganizationMembers(
  client: DbClient,
  organizationId: string,
): Promise<MemberDirectoryRow[]> {
  const { data, error } = await client.rpc('org_members_with_email', {
    target_organization_id: organizationId,
  });

  if (error) throw new Error(`getOrganizationMembers: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    email: row.email ?? '',
    role: row.role === 'owner' ? 'owner' : 'staff',
    memberSince: row.created_at,
  }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/members-directory.test.ts
```
Expected: PASS, all 4 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/members/queries.ts tests/integration/members-directory.test.ts
git commit -m "Add getOrganizationMembers read model"
```

---

### Task 5: Miembros page

**Files:**
- Create: `src/app/members/page.tsx`
- Create: `src/app/members/members-directory.tsx`

**Interfaces:**
- Consumes: `requireStaff`, `getOrganizationMembers`, `MemberDirectoryRow` from Task 4, `AppShell`, `IconMail`.

- [ ] **Step 1: Write the Server Component**

```tsx
// src/app/members/page.tsx
/*
 * Miembros — Server Component. A team directory: any active member can view it (product
 * decision, see docs/superpowers/specs/2026-07-27-staff-nav-pages-design.md). Only the "Invitar
 * miembro" control is owner-gated, and even for an owner it renders disabled — inviting isn't
 * real yet (needs SMTP + a real auth-user-creation flow), so nothing here pretends otherwise.
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getOrganizationMembers } from "@/features/members/queries";
import { MembersDirectory } from "./members-directory";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const members = await getOrganizationMembers(supabase, staff.organizationId);

  return (
    <MembersDirectory
      members={members}
      isOwner={staff.role === "owner"}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
```

- [ ] **Step 2: Write the Client Component**

```tsx
// src/app/members/members-directory.tsx
"use client";

import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconMail } from "@/components/icons";
import type { MemberDirectoryRow } from "@/features/members/queries";

const ROLE_LABEL: Record<MemberDirectoryRow["role"], string> = {
  owner: "Propietario",
  staff: "Staff",
};

function formatMemberSince(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", { year: "numeric", month: "long", day: "numeric" });
}

export function MembersDirectory({
  members,
  isOwner,
  account,
}: {
  members: MemberDirectoryRow[];
  isOwner: boolean;
  account: ShellAccount;
}) {
  return (
    <AppShell active="members" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Miembros</h1>
        {isOwner && (
          <div className="group relative ml-auto">
            <button
              type="button"
              disabled
              className="flex cursor-not-allowed items-center gap-2 rounded-input bg-royal-600/40 px-4 py-2 text-sm font-semibold text-white/70"
            >
              <IconMail className="size-4" /> Invitar miembro
            </button>
            <div className="pointer-events-none absolute right-0 top-full z-10 mt-2 w-56 rounded-input border border-border bg-surface px-3 py-2 text-xs text-text-secondary opacity-0 shadow-md transition-opacity group-hover:opacity-100">
              Próximamente: la invitación por correo estará disponible pronto.
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold tracking-tight text-text-primary">Miembros</h2>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">
            Todo el equipo de tu organización. Cualquier miembro puede ver este directorio.
          </p>
        </div>

        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-app-bg text-xs font-semibold uppercase tracking-wider text-text-secondary">
              <tr>
                <th className="px-5 py-3">Correo</th>
                <th className="px-5 py-3">Rol</th>
                <th className="px-5 py-3">Miembro desde</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-5 py-3 font-medium text-text-primary">{m.email}</td>
                  <td className="px-5 py-3 text-text-secondary">{ROLE_LABEL[m.role]}</td>
                  <td className="px-5 py-3 text-text-secondary">{formatMemberSince(m.memberSince)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 4: Manual verification**

Log in as `staff@docuflow.mx` (seeded as owner), visit `/members`, confirm the directory renders and the disabled "Invitar miembro" button shows the "Próximamente" tooltip on hover. Then confirm (e.g. by temporarily checking the DB or reasoning from the seed script) that a non-owner staff account would see the directory with no invite control at all.

- [ ] **Step 5: Commit**

```bash
git add src/app/members/page.tsx src/app/members/members-directory.tsx
git commit -m "Add the Miembros directory page"
```

---

### Task 6: ActorContext type and organization.updated audit action

**Files:**
- Modify: `src/application/errors.ts`
- Modify: `src/features/audit/record.ts`

**Interfaces:**
- Produces: `interface ActorContext { readonly authUserId: string }` exported from `src/application/errors.ts`; `'organization.updated'` added to the `AuditAction` union. Task 7 depends on both.

- [ ] **Step 1: Add `ActorContext` to `src/application/errors.ts`**

Add after the `FailureReason` type and before `UseCaseError`:

```ts
/**
 * The minimal identity a use case needs to authorize itself, independent of whatever the caller
 * (a Server Action, a script, a test) already believes about that identity's role. A use case
 * that receives only this and re-derives authorization from the database — rather than trusting
 * a boolean the caller hands it — cannot be bypassed by a caller-side bug.
 */
export interface ActorContext {
  readonly authUserId: string;
}
```

- [ ] **Step 2: Add `'organization.updated'` to `AuditAction`**

In `src/features/audit/record.ts`, change:
```ts
export type AuditAction =
  | 'case.created'
  | 'case.state_changed'
```
to:
```ts
export type AuditAction =
  | 'organization.updated'
  | 'case.created'
  | 'case.state_changed'
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```
Expected: clean (this is an additive-only change; nothing consumes either type yet).

- [ ] **Step 4: Commit**

```bash
git add src/application/errors.ts src/features/audit/record.ts
git commit -m "Add ActorContext type and organization.updated audit action"
```

---

### Task 7: `updateOrganization` use case

**Files:**
- Create: `src/application/update-organization.ts`
- Test: `tests/integration/update-organization.test.ts`

**Interfaces:**
- Consumes: `ActorContext`, `UseCaseError`, `parseInput` from Task 6 / existing modules; `logDomainEvent` from `@/application/events`; `buildOrganizationWorld` from fixtures.
- Produces: `updateOrganization(client: DbClient, input: UpdateOrganizationInput, actor: ActorContext): Promise<void>` and `interface UpdateOrganizationInput { readonly organizationId: string; readonly name: string; readonly industry: string }`. Task 8 depends on this.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/update-organization.test.ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { adminClient } from '../helpers/clients';
import { buildOrganizationWorld } from '../helpers/fixtures';
import { updateOrganization } from '@/application/update-organization';
import { UseCaseError } from '@/application/errors';

describe('updateOrganization', () => {
  it('lets the owner update name and industry, logging exactly one event', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Original',
      industry: 'notary',
      clientEmail: `owner-update-${randomUUID()}@example.test`,
    });

    await updateOrganization(
      world.owner.client,
      { organizationId: world.organizationId, name: 'Notaría Renombrada', industry: 'legal' },
      { authUserId: world.owner.userId },
    );

    const { data: org } = await adminClient()
      .from('organizations')
      .select('name, industry')
      .eq('id', world.organizationId)
      .single();
    expect(org?.name).toBe('Notaría Renombrada');
    expect(org?.industry).toBe('legal');

    const { data: events } = await adminClient()
      .from('audit_events')
      .select('id')
      .eq('organization_id', world.organizationId)
      .eq('action', 'organization.updated');
    expect(events).toHaveLength(1);
  });

  it('refuses a non-owner staff member via the use case\'s own ActorContext check', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Staff Refused',
      industry: 'notary',
      clientEmail: `staff-refused-${randomUUID()}@example.test`,
    });

    await expect(
      updateOrganization(
        world.staff.client,
        { organizationId: world.organizationId, name: 'Intento no autorizado', industry: 'legal' },
        { authUserId: world.staff.userId },
      ),
    ).rejects.toMatchObject({ reason: 'forbidden' });

    await expect(
      updateOrganization(
        world.staff.client,
        { organizationId: world.organizationId, name: 'Intento no autorizado', industry: 'legal' },
        { authUserId: world.staff.userId },
      ),
    ).rejects.toBeInstanceOf(UseCaseError);
  });

  it('also refuses a non-owner at the RLS floor, independent of the use case', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría RLS Floor',
      industry: 'notary',
      clientEmail: `rls-floor-${randomUUID()}@example.test`,
    });

    // Bypasses the use case entirely — proves organizations_update_by_owner holds even if the
    // application-layer check above had a bug.
    const { error, data } = await world.staff.client
      .from('organizations')
      .update({ name: 'Should not apply' })
      .eq('id', world.organizationId)
      .select();

    expect(data ?? []).toEqual([]);
    expect(error).toBeNull(); // RLS silently matches zero rows rather than erroring
  });

  it('never modifies existing Cases when only industry changes', async () => {
    const world = await buildOrganizationWorld({
      name: 'Notaría Industria',
      industry: 'notary',
      clientEmail: `industry-${randomUUID()}@example.test`,
    });

    const { data: before } = await adminClient()
      .from('cases')
      .select('id, title, state')
      .eq('id', world.caseId)
      .single();

    await updateOrganization(
      world.owner.client,
      { organizationId: world.organizationId, name: 'Notaría Industria', industry: 'accounting' },
      { authUserId: world.owner.userId },
    );

    const { data: after } = await adminClient()
      .from('cases')
      .select('id, title, state')
      .eq('id', world.caseId)
      .single();

    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/integration/update-organization.test.ts
```
Expected: FAIL — `Cannot find module '@/application/update-organization'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/application/update-organization.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from '@/types/database';
import { parseInput } from '@/lib/validation/parse';
import { UseCaseError, type ActorContext } from './errors';
import { logDomainEvent } from './events';

type DbClient = SupabaseClient<Database>;

const updateOrganizationSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  industry: z.enum(['notary', 'accounting', 'legal', 'insurance', 'hr', 'other']),
});

export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Updates an Organization's name and industry.
 *
 * Authorization is explicit and self-contained: this re-derives the actor's role from `members`
 * through the caller's own RLS-scoped `client` — it does not trust anything the caller already
 * believes about `actor`. This is one of three independent layers (the Server Action checks too,
 * and `organizations_update_by_owner` RLS is the floor); none of the three is decorative.
 *
 * Changing `industry` never touches any existing Case, Blueprint, or Requirement — it is read
 * only when *creating* new things (default terminology, starter Blueprints), never retroactively
 * (organizations.industry's own migration comment: "must never branch engine behaviour").
 */
export async function updateOrganization(
  client: DbClient,
  input: UpdateOrganizationInput,
  actor: ActorContext,
): Promise<void> {
  const { organizationId, name, industry } = parseInput(updateOrganizationSchema, input);

  const { data: membership, error: membershipError } = await client
    .from('members')
    .select('role')
    .eq('organization_id', organizationId)
    .eq('user_id', actor.authUserId)
    .maybeSingle();

  if (membershipError) {
    throw new Error(`Could not resolve membership: ${membershipError.message}`);
  }
  if (membership?.role !== 'owner') {
    throw new UseCaseError('forbidden', 'Solo el propietario puede editar esta información.');
  }

  const { error } = await client
    .from('organizations')
    .update({ name, industry })
    .eq('id', organizationId);

  if (error) {
    throw new Error(`Could not update organization: ${error.message}`);
  }

  await logDomainEvent(client, {
    organizationId,
    action: 'organization.updated',
    targetType: 'organization',
    targetId: organizationId,
    actor: { kind: 'member', authUserId: actor.authUserId },
    metadata: { name, industry },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/integration/update-organization.test.ts
```
Expected: PASS, all 4 tests.

- [ ] **Step 5: Lint and typecheck**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/application/update-organization.ts tests/integration/update-organization.test.ts
git commit -m "Add updateOrganization use case with explicit ActorContext authorization"
```

---

### Task 8: Configuración page

**Files:**
- Create: `src/app/settings/page.tsx`
- Create: `src/app/settings/settings-form.tsx`
- Create: `src/app/settings/actions.ts`

**Interfaces:**
- Consumes: `requireStaff`, `getStaffContext` from `@/features/auth/context`; `updateOrganization`, `UpdateOrganizationInput` from Task 7; `fail`, `ok`, `ActionResult` from `@/application/errors`; `AppShell`, `IconShield`.

- [ ] **Step 1: Write the Server Action**

```ts
// src/app/settings/actions.ts
"use server";

/*
 * Server Action for Configuración. Thin: re-establish identity, delegate to the use case, return
 * a typed result. The owner check here is a fast, user-facing rejection for a non-owner hitting
 * this by direct POST — updateOrganization re-checks independently, and RLS is the final floor.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import { updateOrganization, type UpdateOrganizationInput } from "@/application/update-organization";

export async function updateOrganizationAction(
  input: Omit<UpdateOrganizationInput, "organizationId">,
): Promise<ActionResult<null>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }
    if (staff.role !== "owner") {
      return { ok: false, reason: "forbidden", message: "Solo el propietario puede editar esta información." };
    }

    const supabase = await createClient();
    await updateOrganization(
      supabase,
      { ...input, organizationId: staff.organizationId },
      { authUserId: staff.userId },
    );

    revalidatePath("/settings");
    return ok(null);
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 2: Write the Server Component**

```tsx
// src/app/settings/page.tsx
import { requireStaff } from "@/features/auth/context";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const staff = await requireStaff();

  return (
    <SettingsForm
      name={staff.organizationName}
      isOwner={staff.role === "owner"}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
```

Note: `staff.industry` does not exist on `StaffContext` yet — `getStaffContext()` (`src/features/auth/context.ts`) currently selects `organization:organizations(id, name)`, not `industry`. Add it:

```ts
// src/features/auth/context.ts — change the select and the returned shape:
  const { data: membership } = await supabase
    .from("members")
    .select("role, organization:organizations(id, name, industry)")
    .limit(1)
    .maybeSingle();

  if (!membership?.organization) return null;

  return {
    userId: user.id,
    email: user.email ?? "",
    organizationId: membership.organization.id,
    organizationName: membership.organization.name,
    organizationIndustry: membership.organization.industry,
    role: membership.role === "owner" ? "owner" : "staff",
  };
```
And add `readonly organizationIndustry: string;` to the `StaffContext` interface. Then use `staff.organizationIndustry` (not `staff.industry`) in `src/app/settings/page.tsx`'s `<SettingsForm industry={staff.organizationIndustry} ... />` (add that prop).

- [ ] **Step 3: Write the Client Component**

```tsx
// src/app/settings/settings-form.tsx
"use client";

import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconShield } from "@/components/icons";
import { updateOrganizationAction } from "./actions";

const INDUSTRY_LABEL: Record<string, string> = {
  notary: "Notaría",
  accounting: "Contaduría",
  legal: "Legal",
  insurance: "Seguros",
  hr: "Recursos humanos",
  other: "Otro",
};

export function SettingsForm({
  name: initialName,
  industry: initialIndustry,
  isOwner,
  account,
}: {
  name: string;
  industry: string;
  isOwner: boolean;
  account: ShellAccount;
}) {
  const [name, setName] = useState(initialName);
  const [industry, setIndustry] = useState(initialIndustry);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);

  async function save() {
    setPending(true);
    setFeedback(null);
    const result = await updateOrganizationAction({ name, industry });
    setPending(false);
    setConfirming(false);
    setFeedback(
      result.ok
        ? { ok: true, message: "Guardado." }
        : { ok: false, message: result.message },
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (industry !== initialIndustry) {
      setConfirming(true);
      return;
    }
    void save();
  }

  return (
    <AppShell active="settings" account={account}>
      <div className="flex h-16 shrink-0 items-center border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Configuración</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="max-w-lg rounded-card border border-border bg-surface p-6">
          <form onSubmit={onSubmit} className="flex flex-col gap-5">
            <div>
              <label className="text-sm font-medium text-text-primary">Nombre de la organización</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isOwner}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-text-primary">Industria</label>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                disabled={!isOwner}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-royal-500 focus:bg-surface focus:ring-2 focus:ring-royal-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {Object.entries(INDUSTRY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {!isOwner && (
              <p className="text-xs text-text-secondary">Solo el propietario puede editar esta información.</p>
            )}

            {feedback && (
              <p className={`text-sm ${feedback.ok ? "text-success" : "text-error"}`}>{feedback.message}</p>
            )}

            {isOwner && (
              <button
                type="submit"
                disabled={pending}
                className="self-start rounded-input bg-royal-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Guardar"}
              </button>
            )}
          </form>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-royal-50 text-royal-600">
              <IconShield className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Confirmar cambio de industria</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Cambiar la industria no modifica los expedientes ni las plantillas que ya existen —
              solo afecta lo que se cree a partir de ahora.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-input border border-border bg-surface px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-app-bg"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={pending}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:bg-royal-700 disabled:opacity-60"
              >
                {pending ? "Guardando…" : "Confirmar y guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
```

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean. `text-success`/`text-error` are existing tokens (`src/app/globals.css`, already used in `src/app/portal/[token]/portal-client.tsx`).

- [ ] **Step 5: Manual verification**

Log in as the seeded owner, go to `/settings`, change only the name and save (no confirmation dialog should appear), then change the industry and save (confirmation dialog should appear, cancel should close it without saving, confirm should save and show "Guardado."). Log in as a non-owner staff member (if one exists in the seed, or check via `role` in the DB) and confirm both fields render disabled with the explanatory note and no Save button.

- [ ] **Step 6: Commit**

```bash
git add src/app/settings/page.tsx src/app/settings/settings-form.tsx src/app/settings/actions.ts src/features/auth/context.ts
git commit -m "Add the Configuración page with industry-change confirmation"
```

---

### Task 9: Wire "Configuración" into the sidebar as a real link

**Files:**
- Modify: `src/components/app-shell.tsx`

**Interfaces:**
- Consumes: `IconSettings` (already imported).
- Produces: `NavKey` includes `"settings"`; clicking "Configuración" navigates to `/settings` and gets active-state highlighting like the other four entries.

- [ ] **Step 1: Update `NavKey` and `NAV`**

```ts
// src/components/app-shell.tsx — change:
type NavKey = "cases" | "blueprints" | "clients" | "members";

const NAV: { key: NavKey; label: string; href: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { key: "cases", label: "Expedientes", href: "/cases", Icon: IconCases },
  { key: "blueprints", label: "Plantillas", href: "/blueprints", Icon: IconBlueprints },
  { key: "clients", label: "Clientes", href: "/clients", Icon: IconClients },
  { key: "members", label: "Miembros", href: "/members", Icon: IconMembers },
];
```
to:
```ts
type NavKey = "cases" | "blueprints" | "clients" | "members" | "settings";

const NAV: { key: NavKey; label: string; href: string; Icon: (p: IconProps) => React.ReactElement }[] = [
  { key: "cases", label: "Expedientes", href: "/cases", Icon: IconCases },
  { key: "blueprints", label: "Plantillas", href: "/blueprints", Icon: IconBlueprints },
  { key: "clients", label: "Clientes", href: "/clients", Icon: IconClients },
  { key: "members", label: "Miembros", href: "/members", Icon: IconMembers },
  { key: "settings", label: "Configuración", href: "/settings", Icon: IconSettings },
];
```

- [ ] **Step 2: Remove the standalone `Configuración` button**

Delete this block (now redundant — the entry above renders it as a `Link`):
```tsx
        <button className="flex items-center gap-3 rounded-input px-3 py-2.5 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white">
          <IconSettings className="size-[18px]" />
          Configuración
        </button>
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: clean.

- [ ] **Step 4: Manual verification**

Run the app, confirm "Configuración" appears in the main nav list (not the bottom section), navigates to `/settings`, and highlights the same way "Expedientes"/"Plantillas"/etc. do when active.

- [ ] **Step 5: Commit**

```bash
git add src/components/app-shell.tsx
git commit -m "Wire Configuración into the sidebar as a real nav link"
```

---

### Task 10: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

```bash
npx vitest run
```
Expected: every test file passes, including all three new ones from this plan.

- [ ] **Step 2: Lint and typecheck one more time**

```bash
npm run lint
npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Reset and reseed local data, then smoke-test all three pages together**

```bash
npm run db:reset
npm run db:seed
npm run dev
```
Log in as `staff@docuflow.mx` / `docuflow-demo-2026`, click through `Expedientes → Plantillas → Clientes → Miembros → Configuración` in the sidebar and confirm every one renders (no 404s, no dead button), and that the active-nav highlight follows correctly.

- [ ] **Step 4: Final commit if any cleanup was needed**

```bash
git status --short
```
If clean, nothing to commit — this task is verification-only. If lint/typecheck fixes were needed above, commit them here with a message describing what was fixed.
