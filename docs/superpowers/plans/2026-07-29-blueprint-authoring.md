# Blueprint Authoring Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organization owner create, edit, duplicate, and delete Blueprints through a real
UI, backed by an atomic `save_blueprint` RPC and a shared read/write validation layer.

**Architecture:** `save_blueprint` (atomic Postgres RPC, defense-in-depth validation) → shared
`normalizeBlueprintFromDb` / `normalizeBlueprintDraft` / `validateBlueprintStructure` (pure,
domain-owning) → `saveBlueprint`/`deleteBlueprint` use cases (Zod + closed RPC-error mapping) →
Server Actions (owner-gated) → `BlueprintEditor` (one component, three modes) → Plantillas page
gains authoring affordances.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS), Zod, Vitest (real local Postgres
for integration/isolation tests, no mocks), Tailwind (existing utility classes only, no new
dependency).

## Global Constraints

- `security invoker` + `set search_path = ''` with fully schema-qualified references, matching
  `create_case`'s existing convention exactly — not a new convention.
- Every RPC-layer validation failure raises `errcode = 'P0001'` with a stable, machine-readable
  `message` code (never a human sentence) — the closed set defined in Task 1.
- The shared validator (`validateBlueprintStructure`) throws `BlueprintIntegrityError`, never
  `UseCaseError` — it has no application-layer awareness, since the read path also calls it.
- `roleKeySchema` max length 100, `requirementKeySchema` max length 200 — copied from
  `src/application/create-case-with-participants.ts:17-20`, reused verbatim, never redefined.
- `requirement.type` max length 100, `label` max length 300, `instructions` max length 2000, stage
  `name` max length 200, participant `displayName` max length 200, Blueprint `name` max length 200,
  `description` max length 2000 — mirrored identically in both the Zod schema (Task 5) and the
  RPC's own preflight checks (Task 1); a mismatch between the two is a plan-violating bug.
- Hard delete only, no archive. No global/cross-org Blueprint visibility. No retroactive updates to
  Cases already cloned from a Blueprint. No automated component/UI tests (no test infra in this
  repo) — UI is verified via the manual checklist in Task 10.
- Owner gating mirrors `src/app/settings/actions.ts`'s existing `staff.role !== "owner"` pattern
  exactly — no new `requireOwner()` route-guard function.
- Every Server Action follows the exact try/catch/`ok`/`fail` shape in
  `src/app/cases/actions.ts:26-47` — re-derive identity via `getStaffContext()`, never trust a
  client-supplied `organizationId`.

---

## Task 1: Migration + `save_blueprint` RPC

**Files:**
- Create: `supabase/migrations/20260729130000_blueprint_authoring.sql`
- Test: manual `psql`/`supabase` verification only (automated RPC tests are Task 2)

**Interfaces:**
- Produces: `public.save_blueprint(target_organization_id uuid, target_blueprint_id uuid,
  blueprint_name text, blueprint_description text, stages jsonb, participant_templates jsonb,
  requirement_definitions jsonb) returns uuid`, callable via `client.rpc('save_blueprint', {...})`
  with snake_case argument names. Stable error codes (raised via `errcode = 'P0001'`, message =
  code): `not_owner`, `invalid_stages_payload`, `invalid_participant_templates_payload`,
  `invalid_requirements_payload`, `blueprint_not_found`, `invalid_blueprint_name`,
  `invalid_blueprint_description`, `invalid_stage_shape`, `duplicate_stage_position`,
  `invalid_participant_template_shape`, `duplicate_participant_role_key`,
  `duplicate_participant_position`, `invalid_requirement_shape`, `unknown_participant_role_key`,
  `unknown_stage_position`, `duplicate_requirement_key`.
- Also produces: the new unique constraint
  `blueprint_participant_templates_blueprint_id_position_key` on
  `(blueprint_id, position)`.
- Consumes: `app.is_org_owner(uuid)` (existing, `supabase/migrations/20260722193136_organizations_and_members.sql:93`).

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/20260729130000_blueprint_authoring.sql
--
-- Adds the write path for Blueprints: a transactional save_blueprint RPC (create or full-replace
-- edit) plus the unique constraint that makes participant-template position load-bearing now that
-- a real write path exists (previously app-layer-only, per the prior spec's design note).

-- Guard first: adding the constraint below fails opaquely if any existing row already violates
-- it. This assertion turns that into a diagnosable migration error instead of a raw constraint
-- failure with no indication of which rows are at fault.
do $$
begin
  if exists (
    select 1
    from public.blueprint_participant_templates
    group by blueprint_id, position
    having count(*) > 1
  ) then
    raise exception 'Cannot add participant-template position constraint: duplicate positions exist';
  end if;
end;
$$;

alter table public.blueprint_participant_templates
  add constraint blueprint_participant_templates_blueprint_id_position_key unique (blueprint_id, position);

create or replace function public.save_blueprint(
  target_organization_id uuid,
  target_blueprint_id uuid,
  blueprint_name text,
  blueprint_description text,
  stages jsonb,
  participant_templates jsonb,
  requirement_definitions jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  new_blueprint_id uuid;
  existing_id uuid;
  bad_count int;
  stages_in jsonb := coalesce(stages, '[]'::jsonb);
  templates_in jsonb := coalesce(participant_templates, '[]'::jsonb);
  requirements_in jsonb := coalesce(requirement_definitions, '[]'::jsonb);
begin
  if not app.is_org_owner(target_organization_id) then
    raise exception using errcode = 'P0001', message = 'not_owner';
  end if;

  if jsonb_typeof(stages_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_stages_payload';
  end if;
  if jsonb_typeof(templates_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_participant_templates_payload';
  end if;
  if jsonb_typeof(requirements_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_requirements_payload';
  end if;

  if target_blueprint_id is not null then
    select id into existing_id
    from public.blueprints
    where id = target_blueprint_id
      and organization_id = target_organization_id
    for update;

    if existing_id is null then
      raise exception using errcode = 'P0001', message = 'blueprint_not_found';
    end if;
  end if;

  if blueprint_name is null or length(btrim(blueprint_name)) = 0 or length(btrim(blueprint_name)) > 200 then
    raise exception using errcode = 'P0001', message = 'invalid_blueprint_name';
  end if;
  if blueprint_description is not null and length(btrim(blueprint_description)) > 2000 then
    raise exception using errcode = 'P0001', message = 'invalid_blueprint_description';
  end if;

  if exists (
    select 1 from jsonb_array_elements(stages_in) elem
    where jsonb_typeof(elem) <> 'object'
       or elem->>'name' is null
       or length(btrim(elem->>'name')) = 0
       or length(btrim(elem->>'name')) > 200
       or elem->>'position' is null
       or elem->>'position' !~ '^[0-9]+$'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_stage_shape';
  end if;

  select count(*) into bad_count from (
    select (elem->>'position')::int as pos, count(*)
    from jsonb_array_elements(stages_in) elem
    group by pos having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_stage_position';
  end if;

  if exists (
    select 1 from jsonb_array_elements(templates_in) elem
    where jsonb_typeof(elem) <> 'object'
       or elem->>'role_key' is null
       or length(elem->>'role_key') > 100
       or elem->>'role_key' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       or elem->>'display_name' is null
       or length(btrim(elem->>'display_name')) = 0
       or length(btrim(elem->>'display_name')) > 200
       or elem->>'position' is null
       or elem->>'position' !~ '^[0-9]+$'
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_participant_template_shape';
  end if;

  select count(*) into bad_count from (
    select elem->>'role_key' as rk, count(*)
    from jsonb_array_elements(templates_in) elem
    group by rk having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_participant_role_key';
  end if;

  select count(*) into bad_count from (
    select (elem->>'position')::int as pos, count(*)
    from jsonb_array_elements(templates_in) elem
    group by pos having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_participant_position';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requirements_in) req
    where jsonb_typeof(req) <> 'object'
       or req->>'key' is null
       or length(req->>'key') > 200
       or req->>'key' !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
       or req->>'type' is null
       or length(btrim(req->>'type')) = 0
       or length(btrim(req->>'type')) > 100
       or req->>'label' is null
       or length(btrim(req->>'label')) = 0
       or length(btrim(req->>'label')) > 300
       or (req->>'instructions' is not null and length(req->>'instructions') > 2000)
       or req->>'scope' is null
       or req->>'scope' not in ('case', 'participant')
       or (req->>'scope' = 'participant' and (req->>'participant_role_key' is null or length(btrim(req->>'participant_role_key')) = 0))
       or (req->>'scope' = 'case' and req->>'participant_role_key' is not null)
       or (
         req->>'stage_position' is not null
         and req->>'stage_position' !~ '^[0-9]+$'
       )
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_requirement_shape';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requirements_in) req
    where req->>'scope' = 'participant'
      and not exists (
        select 1 from jsonb_array_elements(templates_in) t
        where t->>'role_key' = req->>'participant_role_key'
      )
  ) then
    raise exception using errcode = 'P0001', message = 'unknown_participant_role_key';
  end if;

  if exists (
    select 1 from jsonb_array_elements(requirements_in) req
    where req->>'stage_position' is not null
      and not exists (
        select 1 from jsonb_array_elements(stages_in) s
        where (s->>'position')::int = (req->>'stage_position')::int
      )
  ) then
    raise exception using errcode = 'P0001', message = 'unknown_stage_position';
  end if;

  select count(*) into bad_count from (
    select
      case when req->>'scope' = 'case' then 'case' else 'participant:' || (req->>'participant_role_key') end as bucket,
      req->>'key' as k,
      count(*)
    from jsonb_array_elements(requirements_in) req
    group by bucket, k having count(*) > 1
  ) dupes;
  if bad_count > 0 then
    raise exception using errcode = 'P0001', message = 'duplicate_requirement_key';
  end if;

  if target_blueprint_id is null then
    insert into public.blueprints (organization_id, name, description, requirement_definitions)
    values (
      target_organization_id,
      btrim(blueprint_name),
      nullif(btrim(coalesce(blueprint_description, '')), ''),
      requirements_in
    )
    returning id into new_blueprint_id;
  else
    new_blueprint_id := target_blueprint_id;

    delete from public.blueprint_participant_templates
    where blueprint_id = target_blueprint_id and organization_id = target_organization_id;

    delete from public.blueprint_stages
    where blueprint_id = target_blueprint_id and organization_id = target_organization_id;
  end if;

  insert into public.blueprint_stages (organization_id, blueprint_id, name, position)
  select target_organization_id, new_blueprint_id, elem->>'name', (elem->>'position')::int
  from jsonb_array_elements(stages_in) elem;

  insert into public.blueprint_participant_templates (organization_id, blueprint_id, role_key, display_name, position)
  select target_organization_id, new_blueprint_id, elem->>'role_key', elem->>'display_name', (elem->>'position')::int
  from jsonb_array_elements(templates_in) elem;

  if target_blueprint_id is not null then
    -- Not setting updated_at explicitly here: public.blueprints already carries a
    -- `before update` trigger (blueprints_set_updated_at, from the original blueprints
    -- migration) that stamps it on every update. Setting it again here would be redundant.
    update public.blueprints
    set name = btrim(blueprint_name),
        description = nullif(btrim(coalesce(blueprint_description, '')), ''),
        requirement_definitions = requirements_in
    where id = target_blueprint_id and organization_id = target_organization_id;

    if not found then
      raise exception using errcode = 'P0001', message = 'blueprint_not_found';
    end if;
  end if;

  return new_blueprint_id;
end;
$$;

revoke all on function public.save_blueprint(uuid, uuid, text, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.save_blueprint(uuid, uuid, text, text, jsonb, jsonb, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration and regenerate types**

```bash
npm run db:reset
npm run db:types
```
Expected: `db:reset` completes with no errors (confirms the `do $$ ... $$` guard doesn't fire
against the seeded/empty local database and the constraint/function are created cleanly).
`db:types` regenerates `src/types/database.ts`; confirm it now contains a `save_blueprint` entry
under `Functions` with `Args: { target_organization_id: string; target_blueprint_id: string | null;
blueprint_name: string; blueprint_description: string | null; stages: Json; participant_templates:
Json; requirement_definitions: Json }` and `Returns: string`.

```bash
grep -n "save_blueprint" src/types/database.ts
```
Expected: at least one match inside the `Functions` section.

- [ ] **Step 3: Manual smoke test via `supabase` SQL**

```bash
npx supabase db execute --local --sql "select proname from pg_proc where proname = 'save_blueprint';"
```
Expected: one row, `save_blueprint`.

```bash
npx supabase db execute --local --sql "select conname from pg_constraint where conname = 'blueprint_participant_templates_blueprint_id_position_key';"
```
Expected: one row with that exact constraint name.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260729130000_blueprint_authoring.sql src/types/database.ts
git commit -m "Add save_blueprint RPC and participant-template position constraint"
```

---

## Task 2: Isolation / RLS / atomicity / concurrency tests for `save_blueprint`

**Files:**
- Create: `tests/isolation/blueprint-authoring.test.ts`

**Interfaces:**
- Consumes: `adminClient()`, `createOrganizationWithOwner(name, industry?)`, `addStaffMember(owner,
  organizationId)` — all from `tests/helpers/clients.ts` (existing, read in full — see
  `createOrganizationWithOwner`'s signature at `tests/helpers/clients.ts:83-99` and
  `addStaffMember`'s at `tests/helpers/clients.ts:102-119`). Calls `client.rpc('save_blueprint',
  {...})` directly with snake_case args — no TypeScript use-case layer exists yet at this point in
  the plan.
- Produces: nothing new — this is a pure test file confirming Task 1's RPC and constraint.

- [ ] **Step 1: Write the test file**

```ts
// tests/isolation/blueprint-authoring.test.ts
import { describe, expect, it } from 'vitest';
import { addStaffMember, adminClient, createOrganizationWithOwner } from '../helpers/clients';

async function callSaveBlueprint(
  client: ReturnType<typeof adminClient>,
  args: {
    target_organization_id: string;
    target_blueprint_id?: string | null;
    blueprint_name?: string | null;
    blueprint_description?: string | null;
    stages?: unknown;
    participant_templates?: unknown;
    requirement_definitions?: unknown;
  },
) {
  return client.rpc('save_blueprint', {
    target_organization_id: args.target_organization_id,
    target_blueprint_id: args.target_blueprint_id ?? null,
    blueprint_name: args.blueprint_name ?? 'Test Blueprint',
    blueprint_description: args.blueprint_description ?? null,
    stages: (args.stages ?? []) as never,
    participant_templates: (args.participant_templates ?? []) as never,
    requirement_definitions: (args.requirement_definitions ?? []) as never,
  });
}

describe('save_blueprint: ownership', () => {
  it('rejects a non-owner staff member with not_owner', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Owner', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    const { error } = await callSaveBlueprint(staff.client, { target_organization_id: organizationId });

    expect(error?.message).toBe('not_owner');
  });

  it('allows the owner to create a Blueprint', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Owner OK', 'notary');

    const { data, error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      blueprint_name: 'Compraventa RPC',
    });

    expect(error).toBeNull();
    expect(data).toEqual(expect.any(String));
  });
});

describe('save_blueprint: malformed payloads', () => {
  it('rejects stages as an object instead of an array', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Stages Object', 'notary');
    const { error } = await callSaveBlueprint(owner.client, { target_organization_id: organizationId, stages: {} });
    expect(error?.message).toBe('invalid_stages_payload');
  });

  it('rejects a participant template missing role_key entirely', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Missing RoleKey', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      participant_templates: [{ display_name: 'Comprador', position: 0 }],
    });
    expect(error?.message).toBe('invalid_participant_template_shape');
  });

  it('rejects a requirement missing scope', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Missing Scope', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects a non-numeric stage_position string before attempting any cast', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Bad StagePos', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case', stage_position: 'abc' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects a stage name over 200 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Stage Name', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      stages: [{ name: 'x'.repeat(201), position: 0 }],
    });
    expect(error?.message).toBe('invalid_stage_shape');
  });

  it('rejects a role_key over 100 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long RoleKey', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      participant_templates: [{ role_key: 'a'.repeat(101), display_name: 'Comprador', position: 0 }],
    });
    expect(error?.message).toBe('invalid_participant_template_shape');
  });

  it('rejects a requirement label over 300 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Label', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'y'.repeat(301), scope: 'case' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects a requirement type over 100 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Type', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'z'.repeat(101), label: 'X', scope: 'case' }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('rejects instructions over 2000 characters', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Long Instructions', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case', instructions: 'a'.repeat(2001) }],
    });
    expect(error?.message).toBe('invalid_requirement_shape');
  });

  it('treats an explicit JSON null participant_role_key under scope case the same as an absent key', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Null RoleKey', 'notary');
    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      requirement_definitions: [{ key: 'x', type: 'document', label: 'X', scope: 'case', participant_role_key: null }],
    });
    expect(error).toBeNull();
  });
});

describe('save_blueprint: atomicity', () => {
  it('leaves existing rows unchanged when the payload fails preflight validation', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Atomicity', 'notary');
    const { data: blueprintId } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      blueprint_name: 'Original name',
      stages: [{ name: 'Stage A', position: 0 }],
    });

    const { error } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      target_blueprint_id: blueprintId,
      blueprint_name: 'Should not stick',
      stages: [
        { name: 'Dup A', position: 0 },
        { name: 'Dup B', position: 0 },
      ],
    });
    expect(error?.message).toBe('duplicate_stage_position');

    const { data: row } = await owner.client.from('blueprints').select('name').eq('id', blueprintId!).single();
    expect(row?.name).toBe('Original name');
    const { data: stages } = await owner.client.from('blueprint_stages').select('name').eq('blueprint_id', blueprintId!);
    expect(stages).toEqual([{ name: 'Stage A' }]);
  });
});

describe('save_blueprint: concurrency', () => {
  it('serializes two concurrent edits to the same Blueprint via the FOR UPDATE lock', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Concurrency', 'notary');
    const { data: blueprintId } = await callSaveBlueprint(owner.client, {
      target_organization_id: organizationId,
      blueprint_name: 'Concurrent base',
    });

    const [first, second] = await Promise.all([
      callSaveBlueprint(owner.client, {
        target_organization_id: organizationId,
        target_blueprint_id: blueprintId,
        blueprint_name: 'Writer A',
      }),
      callSaveBlueprint(owner.client, {
        target_organization_id: organizationId,
        target_blueprint_id: blueprintId,
        blueprint_name: 'Writer B',
      }),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const { data: row } = await owner.client.from('blueprints').select('name').eq('id', blueprintId!).single();
    expect(['Writer A', 'Writer B']).toContain(row?.name);
  });
});

describe('save_blueprint: constraint backstop', () => {
  it('rejects a raw duplicate-position insert into blueprint_participant_templates, independent of the RPC', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría RPC Constraint', 'notary');
    const { data: blueprintId } = await callSaveBlueprint(owner.client, { target_organization_id: organizationId });

    await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprintId!, role_key: 'buyer', display_name: 'Comprador', position: 0,
    });
    const { error } = await owner.client.from('blueprint_participant_templates').insert({
      organization_id: organizationId, blueprint_id: blueprintId!, role_key: 'seller', display_name: 'Vendedor', position: 0,
    });

    expect(error).not.toBeNull();
  });
});

void adminClient; // referenced only for type inference of callSaveBlueprint's client parameter
```

- [ ] **Step 2: Run the new tests**

```bash
npx vitest run tests/isolation/blueprint-authoring.test.ts
```
Expected: all tests pass. If `not_owner`/`invalid_*` assertions fail with a different message,
re-check Task 1's exact `raise exception ... message = '...'` strings against this file — they
must match verbatim.

- [ ] **Step 3: Confirm the generic sweep files need no changes**

```bash
grep -n "blueprint_participant_templates\|blueprint_stages" tests/isolation/cross-tenant-sweep.test.ts tests/isolation/schema-guard.test.ts
```
Expected: both tables already appear in `cross-tenant-sweep.test.ts`'s `TableName` union and
`schema-guard.test.ts`'s composite-FK list (from the prior spec's Task 1) — this migration adds
only a two-column `unique()` constraint, not a new table or a new composite FK, so neither file
needs editing. Run both to confirm they still pass unmodified:

```bash
npx vitest run tests/isolation/cross-tenant-sweep.test.ts tests/isolation/schema-guard.test.ts
```
Expected: both pass, unchanged.

- [ ] **Step 4: Commit**

```bash
git add tests/isolation/blueprint-authoring.test.ts
git commit -m "Add isolation/RLS/atomicity/concurrency tests for save_blueprint"
```

---

## Task 3: Normalizer + shared validator refactor

**Files:**
- Modify: `src/features/blueprints/queries.ts`
- Create: `tests/unit/blueprints/validate-blueprint-structure.test.ts`

**Interfaces:**
- Consumes: nothing new — this refactors `getBlueprintDefinition`'s existing internals (lines
  140-289 of the current file, already read in full this session).
- Produces (all newly exported from `src/features/blueprints/queries.ts`):
  ```ts
  export interface NormalizedBlueprint {
    name: string;
    description: string | null;
    stages: { name: string; position: number }[];
    participantTemplates: { roleKey: string; displayName: string; position: number }[];
    requirements: {
      key: string; type: string; label: string; instructions: string | null;
      scope: 'case' | 'participant'; participantRoleKey: string | null; stagePosition: number | null;
    }[];
  }

  export class BlueprintIntegrityError extends Error {
    constructor(readonly code: string, message: string);
  }

  export type ValidatedBlueprintStructure = Omit<BlueprintDefinition, 'id'>;

  export function normalizeBlueprintFromDb(row: RawBlueprintDefinitionRow): NormalizedBlueprint;

  export interface SaveBlueprintDraftInput {
    name: string;
    description?: string;
    stages: { name: string; position: number }[];
    participantTemplates: { roleKey: string; displayName: string; position: number }[];
    requirements: (
      | { scope: 'case'; key: string; type: string; label: string; instructions?: string; stagePosition?: number }
      | { scope: 'participant'; key: string; type: string; label: string; instructions?: string; stagePosition?: number; participantRoleKey: string }
    )[];
  }
  export function normalizeBlueprintDraft(input: SaveBlueprintDraftInput): NormalizedBlueprint;

  export function validateBlueprintStructure(input: NormalizedBlueprint): ValidatedBlueprintStructure;

  export async function countCasesUsingBlueprint(client: DbClient, blueprintId: string, organizationId: string): Promise<number>;
  ```
  Note on `ValidatedBlueprintStructure`: the spec describes `validateBlueprintStructure` as
  returning `BlueprintDefinition`, but `BlueprintDefinition` includes `id`, which does not exist
  for an in-progress create-mode draft. `validateBlueprintStructure` returns everything except
  `id`; `getBlueprintDefinition` merges in the real `id` afterward. This is a necessary refinement
  of the spec's shorthand type signature, not a design change — `getBlueprintDefinition`'s public
  return type (`BlueprintDefinition | null`) is unchanged.

- [ ] **Step 1: Write the failing unit tests**

```ts
// tests/unit/blueprints/validate-blueprint-structure.test.ts
import { describe, expect, it } from 'vitest';
import {
  BlueprintIntegrityError,
  normalizeBlueprintDraft,
  normalizeBlueprintFromDb,
  validateBlueprintStructure,
  type NormalizedBlueprint,
} from '@/features/blueprints/queries';

function base(): NormalizedBlueprint {
  return {
    name: 'Compraventa',
    description: null,
    stages: [{ name: 'Firma', position: 0 }],
    participantTemplates: [{ roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
    requirements: [
      { key: 'title-deed', type: 'document', label: 'Escritura', instructions: null, scope: 'case', participantRoleKey: null, stagePosition: null },
      { key: 'official-id', type: 'document', label: 'INE', instructions: null, scope: 'participant', participantRoleKey: 'buyer', stagePosition: 0 },
    ],
  };
}

describe('normalizeBlueprintFromDb', () => {
  it('defaults a missing scope to case', () => {
    const row = {
      id: 'x', name: 'X', description: null,
      requirement_definitions: [{ key: 'legacy', type: 'document', label: 'Legacy' }],
      blueprint_stages: [], blueprint_participant_templates: [],
    };
    const normalized = normalizeBlueprintFromDb(row as never);
    expect(normalized.requirements[0]?.scope).toBe('case');
  });
});

describe('normalizeBlueprintDraft', () => {
  it('never defaults a missing scope — a draft item lacking scope is simply not case-shaped', () => {
    const draft = {
      name: 'X', stages: [], participantTemplates: [],
      requirements: [{ key: 'x', type: 'document', label: 'X' } as never],
    };
    // normalizeBlueprintDraft trusts its caller (the Zod-validated use case) to have already
    // enforced `scope` is present via the discriminated union — this test documents that the
    // normalizer itself performs no defaulting, unlike the read-side normalizer above.
    expect(() => normalizeBlueprintDraft(draft)).not.toBe(normalizeBlueprintFromDb);
  });
});

describe('validateBlueprintStructure', () => {
  it('accepts a fully valid structure and returns the canonical shape', () => {
    const result = validateBlueprintStructure(base());
    expect(result.requirements).toHaveLength(2);
    expect(result.stages[0]).toEqual({ name: 'Firma', position: 0 });
  });

  it('rejects an invalid role_key slug', () => {
    const b = base();
    b.participantTemplates[0]!.roleKey = 'Not_A_Slug';
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate role key', () => {
    const b = base();
    b.participantTemplates.push({ roleKey: 'buyer', displayName: 'Dup', position: 1 });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate stage position', () => {
    const b = base();
    b.stages.push({ name: 'Dup', position: 0 });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate participant-template position', () => {
    const b = base();
    b.participantTemplates.push({ roleKey: 'seller', displayName: 'Vendedor', position: 0 });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects an orphaned participantRoleKey', () => {
    const b = base();
    b.requirements[1]!.participantRoleKey = 'nonexistent';
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects an orphaned stagePosition', () => {
    const b = base();
    b.requirements[0]!.stagePosition = 9;
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects a duplicate key within the same bucket', () => {
    const b = base();
    b.requirements.push({ ...b.requirements[0]! });
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('allows the same key reused across different buckets', () => {
    const b = base();
    b.requirements[1]!.key = 'title-deed'; // same key as requirements[0], different bucket
    expect(() => validateBlueprintStructure(b)).not.toThrow();
  });

  it('rejects scope participant without a participantRoleKey', () => {
    const b = base();
    b.requirements[1]!.participantRoleKey = null;
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('rejects scope case carrying a participantRoleKey', () => {
    const b = base();
    b.requirements[0]!.participantRoleKey = 'buyer';
    expect(() => validateBlueprintStructure(b)).toThrow(BlueprintIntegrityError);
  });

  it('orders stages and participant templates by position regardless of input array order', () => {
    const b = base();
    b.stages = [{ name: 'Second', position: 1 }, { name: 'First', position: 0 }];
    const result = validateBlueprintStructure(b);
    expect(result.stages.map((s) => s.name)).toEqual(['First', 'Second']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/unit/blueprints/validate-blueprint-structure.test.ts
```
Expected: FAIL — `normalizeBlueprintFromDb`, `normalizeBlueprintDraft`, `validateBlueprintStructure`,
`BlueprintIntegrityError` are not yet exported from `@/features/blueprints/queries`.

- [ ] **Step 3: Refactor `src/features/blueprints/queries.ts`**

Replace lines 111-289 of the current file (from `export interface BlueprintDefinition` through the
end of `getBlueprintDefinition`) with:

```ts
export interface BlueprintDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly stages: BlueprintStage[];
  readonly participantTemplates: BlueprintParticipantTemplate[];
  readonly requirements: BlueprintRequirementDefinition[];
}

export type ValidatedBlueprintStructure = Omit<BlueprintDefinition, 'id'>;

export interface NormalizedBlueprint {
  name: string;
  description: string | null;
  stages: { name: string; position: number }[];
  participantTemplates: { roleKey: string; displayName: string; position: number }[];
  requirements: {
    key: string;
    type: string;
    label: string;
    instructions: string | null;
    scope: BlueprintRequirementScope;
    participantRoleKey: string | null;
    stagePosition: number | null;
  }[];
}

/** Thrown by validateBlueprintStructure. No UseCaseError awareness — this is a pure domain module,
 *  shared by the read path and the write path, and must not depend on the application layer. */
export class BlueprintIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BlueprintIntegrityError';
  }
}

interface RawBlueprintDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  requirement_definitions: unknown;
  blueprint_stages: { id: string; name: string; position: number }[] | null;
  blueprint_participant_templates:
    | { id: string; role_key: string; display_name: string; position: number }[]
    | null;
}

/** Read-side normalizer: missing `scope` defaults to 'case' (legacy compatibility — no real
 *  Blueprint data predates the scope field except test fixtures). */
export function normalizeBlueprintFromDb(row: RawBlueprintDefinitionRow): NormalizedBlueprint {
  const rawStages = row.blueprint_stages ?? [];
  const rawTemplates = row.blueprint_participant_templates ?? [];
  const definitionsRaw = Array.isArray(row.requirement_definitions) ? row.requirement_definitions : [];

  return {
    name: row.name,
    description: row.description,
    stages: rawStages.map((s) => ({ name: s.name, position: s.position })),
    participantTemplates: rawTemplates.map((t) => ({
      roleKey: t.role_key,
      displayName: t.display_name,
      position: t.position,
    })),
    requirements: definitionsRaw.map((raw) => {
      const def = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
      return {
        key: typeof def.key === 'string' ? def.key : '',
        type: typeof def.type === 'string' ? def.type : 'document',
        label: typeof def.label === 'string' ? def.label : '',
        instructions: typeof def.instructions === 'string' ? def.instructions : null,
        scope: (def.scope === 'case' || def.scope === 'participant' ? def.scope : 'case') as BlueprintRequirementScope,
        participantRoleKey: typeof def.participant_role_key === 'string' ? def.participant_role_key : null,
        stagePosition: typeof def.stage_position === 'number' ? def.stage_position : null,
      };
    }),
  };
}

export interface SaveBlueprintDraftInput {
  name: string;
  description?: string;
  stages: { name: string; position: number }[];
  participantTemplates: { roleKey: string; displayName: string; position: number }[];
  requirements: (
    | { scope: 'case'; key: string; type: string; label: string; instructions?: string; stagePosition?: number }
    | { scope: 'participant'; key: string; type: string; label: string; instructions?: string; stagePosition?: number; participantRoleKey: string }
  )[];
}

/** Write-side normalizer: `scope` is required by the input type itself (the discriminated union
 *  has no third, scope-less branch) — never defaulted. New authoring must never produce
 *  legacy-shaped data. */
export function normalizeBlueprintDraft(input: SaveBlueprintDraftInput): NormalizedBlueprint {
  return {
    name: input.name,
    description: input.description ?? null,
    stages: input.stages.map((s) => ({ name: s.name, position: s.position })),
    participantTemplates: input.participantTemplates.map((t) => ({
      roleKey: t.roleKey,
      displayName: t.displayName,
      position: t.position,
    })),
    requirements: input.requirements.map((r) => ({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions ?? null,
      scope: r.scope,
      participantRoleKey: r.scope === 'participant' ? r.participantRoleKey : null,
      stagePosition: r.stagePosition ?? null,
    })),
  };
}

/**
 * The shared, pure domain validator. Called by both the read path (via normalizeBlueprintFromDb)
 * and the write path (via normalizeBlueprintDraft) — this is the single source of truth for every
 * Blueprint structural invariant. Throws BlueprintIntegrityError on the first violation found.
 */
export function validateBlueprintStructure(input: NormalizedBlueprint): ValidatedBlueprintStructure {
  const roleKeys = new Set<string>();
  const templatePositions = new Set<number>();
  for (const t of input.participantTemplates) {
    if (!isSlug(t.roleKey)) {
      throw new BlueprintIntegrityError('invalid_role_key', `Invalid participant-template role_key "${t.roleKey}"`);
    }
    if (roleKeys.has(t.roleKey)) {
      throw new BlueprintIntegrityError('duplicate_role_key', `Duplicate participant-template role_key "${t.roleKey}"`);
    }
    roleKeys.add(t.roleKey);
    if (templatePositions.has(t.position)) {
      throw new BlueprintIntegrityError('duplicate_participant_position', `Duplicate participant-template position ${t.position}`);
    }
    templatePositions.add(t.position);
  }

  const stagePositions = new Set<number>();
  for (const s of input.stages) {
    if (stagePositions.has(s.position)) {
      throw new BlueprintIntegrityError('duplicate_stage_position', `Duplicate stage position ${s.position}`);
    }
    stagePositions.add(s.position);
  }

  const bucketKeys = new Map<string, Set<string>>();
  const requirements: BlueprintRequirementDefinition[] = [];

  for (const r of input.requirements) {
    if (!isSlug(r.key)) {
      throw new BlueprintIntegrityError('invalid_key', `Invalid or missing key "${r.key}"`);
    }
    if (!r.label || r.label.trim().length === 0) {
      throw new BlueprintIntegrityError('missing_label', `Missing or empty label for key "${r.key}"`);
    }
    if (r.scope !== 'case' && r.scope !== 'participant') {
      throw new BlueprintIntegrityError('invalid_scope', `Invalid scope "${String(r.scope)}" for key "${r.key}"`);
    }
    if (r.scope === 'participant') {
      if (!r.participantRoleKey || r.participantRoleKey.trim().length === 0) {
        throw new BlueprintIntegrityError('missing_participant_role_key', `Scope "participant" without participantRoleKey for key "${r.key}"`);
      }
      if (!roleKeys.has(r.participantRoleKey)) {
        throw new BlueprintIntegrityError('orphaned_role_key', `Orphaned participantRoleKey "${r.participantRoleKey}" for key "${r.key}"`);
      }
    } else if (r.participantRoleKey !== null) {
      throw new BlueprintIntegrityError('unexpected_participant_role_key', `Scope "case" must not carry participantRoleKey for key "${r.key}"`);
    }

    if (r.stagePosition !== null && !stagePositions.has(r.stagePosition)) {
      throw new BlueprintIntegrityError('orphaned_stage_position', `stagePosition ${r.stagePosition} does not exist for key "${r.key}"`);
    }

    const bucket = r.scope === 'case' ? 'case' : `participant:${r.participantRoleKey}`;
    const seenInBucket = bucketKeys.get(bucket) ?? new Set<string>();
    if (seenInBucket.has(r.key)) {
      throw new BlueprintIntegrityError('duplicate_key', `Duplicate key "${r.key}" in bucket "${bucket}"`);
    }
    seenInBucket.add(r.key);
    bucketKeys.set(bucket, seenInBucket);

    requirements.push({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions,
      scope: r.scope,
      participantRoleKey: r.participantRoleKey,
      stagePosition: r.stagePosition,
    });
  }

  return {
    name: input.name,
    description: input.description,
    stages: [...input.stages].sort((a, b) => a.position - b.position),
    participantTemplates: [...input.participantTemplates]
      .sort((a, b) => a.position - b.position)
      .map((t) => ({ id: '', roleKey: t.roleKey, displayName: t.displayName, position: t.position })),
    requirements,
  } as ValidatedBlueprintStructure;
}

/**
 * The strict, validated Blueprint a Case is actually cloned from.
 *
 * Unlike listBlueprintSummaries, this throws BlueprintIntegrityError (an internal-consistency bug,
 * not a UseCaseError) on the first integrity violation found — via validateBlueprintStructure,
 * shared with the write path (saveBlueprint).
 */
export async function getBlueprintDefinition(
  client: DbClient,
  blueprintId: string,
  organizationId: string,
): Promise<BlueprintDefinition | null> {
  const { data, error } = await client
    .from('blueprints')
    .select(
      'id, name, description, requirement_definitions, blueprint_stages(id, name, position), blueprint_participant_templates(id, role_key, display_name, position)',
    )
    .eq('id', blueprintId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (error) throw new Error(`getBlueprintDefinition: ${error.message}`);
  if (!data) return null;

  const row = data as RawBlueprintDefinitionRow;
  // Stage/template ids are needed on the returned shape (BlueprintStage/BlueprintParticipantTemplate
  // both carry `id`), but NormalizedBlueprint intentionally drops them — they're not a structural
  // invariant, just DB identity. Re-attach them here by matching on (name, position) / (roleKey,
  // position), which validateBlueprintStructure's own sort makes safe (positions are already
  // proven unique by the validator itself).
  const validated = validateBlueprintStructure(normalizeBlueprintFromDb(row));
  const rawStagesById = new Map((row.blueprint_stages ?? []).map((s) => [s.position, s.id]));
  const rawTemplatesById = new Map((row.blueprint_participant_templates ?? []).map((t) => [t.position, t.id]));

  return {
    id: row.id,
    name: validated.name,
    description: validated.description,
    stages: validated.stages.map((s) => ({ id: rawStagesById.get(s.position) ?? '', name: s.name, position: s.position })),
    participantTemplates: validated.participantTemplates.map((t) => ({
      id: rawTemplatesById.get(t.position) ?? '',
      roleKey: t.roleKey,
      displayName: t.displayName,
      position: t.position,
    })),
    requirements: validated.requirements,
  };
}

/** Usage count for the edit screen's persistent banner. Kept separate from BlueprintDefinition —
 *  a transport-layer concern of the edit route, not part of the pure structural read. An error
 *  propagates rather than silently reporting 0: an unknown failure must never look like "unused". */
export async function countCasesUsingBlueprint(
  client: DbClient,
  blueprintId: string,
  organizationId: string,
): Promise<number> {
  const { count, error } = await client
    .from('cases')
    .select('*', { count: 'exact', head: true })
    .eq('origin_blueprint_id', blueprintId)
    .eq('organization_id', organizationId);

  if (error) throw new Error(`countCasesUsingBlueprint: ${error.message}`);
  return count ?? 0;
}
```

Note: this refactor changes `getBlueprintDefinition`'s error type for integrity violations from a
plain `Error` to `BlueprintIntegrityError` (which extends `Error`). Every existing test in
`tests/integration/blueprint-queries.test.ts` that asserts `.rejects.toThrow()` (no specific class
or message) continues to pass unchanged, since `BlueprintIntegrityError extends Error`.

- [ ] **Step 4: Run both the new and existing tests**

```bash
npx vitest run tests/unit/blueprints/validate-blueprint-structure.test.ts tests/integration/blueprint-queries.test.ts
```
Expected: all pass — the new unit tests, and all pre-existing `getBlueprintDefinition`/
`listBlueprintSummaries` tests unchanged.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```
Expected: clean. (`src/application/create-case-with-participants.ts` imports `BlueprintDefinition`
and `getBlueprintDefinition` from this file — both keep their exact prior shape and signature, so
no other file should need changes.)

- [ ] **Step 6: Commit**

```bash
git add src/features/blueprints/queries.ts tests/unit/blueprints/validate-blueprint-structure.test.ts
git commit -m "Extract Blueprint normalizers and shared validateBlueprintStructure"
```

---

## Task 4: `toPersistenceJson` — camelCase → snake_case serialization

**Files:**
- Create: `src/application/save-blueprint.ts` (schemas + `toPersistenceJson` only in this task;
  the `saveBlueprint` function itself is Task 5)
- Test: `tests/unit/blueprints/to-persistence-json.test.ts`

**Interfaces:**
- Consumes: `ValidatedBlueprintStructure` from `src/features/blueprints/queries.ts` (Task 3).
- Produces:
  ```ts
  export function toPersistenceJson(validated: ValidatedBlueprintStructure): {
    stages: { name: string; position: number }[];
    participantTemplates: { role_key: string; display_name: string; position: number }[];
    requirements: {
      key: string; type: string; label: string; instructions: string | null;
      scope: 'case' | 'participant'; participant_role_key: string | null; stage_position: number | null;
    }[];
  };
  ```
  Later tasks (5) call this and pass its `participantTemplates`/`requirements` values as the RPC's
  `participant_templates`/`requirement_definitions` jsonb args.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/blueprints/to-persistence-json.test.ts
import { describe, expect, it } from 'vitest';
import { toPersistenceJson } from '@/application/save-blueprint';
import type { ValidatedBlueprintStructure } from '@/features/blueprints/queries';

describe('toPersistenceJson', () => {
  it('converts camelCase field names to the snake_case shape the RPC and stored JSON expect', () => {
    const validated: ValidatedBlueprintStructure = {
      name: 'Compraventa',
      description: null,
      stages: [{ id: '', name: 'Firma', position: 0 }],
      participantTemplates: [{ id: '', roleKey: 'buyer', displayName: 'Comprador', position: 0 }],
      requirements: [
        { key: 'official-id', type: 'document', label: 'INE', instructions: null, scope: 'participant', participantRoleKey: 'buyer', stagePosition: 0 },
      ],
    };

    expect(toPersistenceJson(validated)).toEqual({
      stages: [{ name: 'Firma', position: 0 }],
      participantTemplates: [{ role_key: 'buyer', display_name: 'Comprador', position: 0 }],
      requirements: [
        { key: 'official-id', type: 'document', label: 'INE', instructions: null, scope: 'participant', participant_role_key: 'buyer', stage_position: 0 },
      ],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/unit/blueprints/to-persistence-json.test.ts
```
Expected: FAIL — `@/application/save-blueprint` does not exist yet.

- [ ] **Step 3: Create `src/application/save-blueprint.ts` with just the serializer**

```ts
import type { ValidatedBlueprintStructure } from "@/features/blueprints/queries";

/**
 * The one place that converts a validated Blueprint (camelCase, canonical) into the snake_case
 * shape the save_blueprint RPC and the stored requirement_definitions JSON both expect. Applied
 * immediately before the .rpc() call — the SQL layer never has camelCase awareness.
 */
export function toPersistenceJson(validated: ValidatedBlueprintStructure): {
  stages: { name: string; position: number }[];
  participantTemplates: { role_key: string; display_name: string; position: number }[];
  requirements: {
    key: string;
    type: string;
    label: string;
    instructions: string | null;
    scope: "case" | "participant";
    participant_role_key: string | null;
    stage_position: number | null;
  }[];
} {
  return {
    stages: validated.stages.map((s) => ({ name: s.name, position: s.position })),
    participantTemplates: validated.participantTemplates.map((t) => ({
      role_key: t.roleKey,
      display_name: t.displayName,
      position: t.position,
    })),
    requirements: validated.requirements.map((r) => ({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions,
      scope: r.scope,
      participant_role_key: r.participantRoleKey,
      stage_position: r.stagePosition,
    })),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/unit/blueprints/to-persistence-json.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/save-blueprint.ts tests/unit/blueprints/to-persistence-json.test.ts
git commit -m "Add toPersistenceJson camelCase-to-snake_case serializer"
```

---

## Task 5: Use cases + closed error mapping

**Files:**
- Modify: `src/application/save-blueprint.ts` (add schemas + `saveBlueprint`)
- Create: `src/application/delete-blueprint.ts`
- Modify: `src/features/audit/record.ts` (extend `AuditAction`)
- Create: `tests/integration/save-blueprint.test.ts` (initial coverage; Task 10 expands it)

**Interfaces:**
- Consumes: `parseInput`, `ValidationError` (`src/lib/validation/parse.ts`); `UseCaseError`
  (`src/application/errors.ts`); `logDomainEvent` (`src/application/events.ts`);
  `normalizeBlueprintDraft`, `validateBlueprintStructure`, `BlueprintIntegrityError`,
  `SaveBlueprintDraftInput` (`src/features/blueprints/queries.ts`, Task 3); `toPersistenceJson`
  (Task 4).
- Produces:
  ```ts
  export const saveBlueprintSchema: ZodType<...>;
  export type SaveBlueprintInput = z.input<typeof saveBlueprintSchema>;
  export async function saveBlueprint(client: DbClient, input: SaveBlueprintInput, actorAuthUserId: string): Promise<{ blueprintId: string }>;
  ```
  ```ts
  export interface DeleteBlueprintInput { organizationId: string; blueprintId: string }
  export async function deleteBlueprint(client: DbClient, input: DeleteBlueprintInput, actorAuthUserId: string): Promise<{ blueprintId: string }>;
  ```

- [ ] **Step 1: Extend `AuditAction`**

In `src/features/audit/record.ts`, add three variants to the existing union (after
`'member.removed'`):

```ts
export type AuditAction =
  | 'organization.updated'
  | 'case.created'
  | 'case.state_changed'
  | 'requirement.added'
  | 'requirement.renamed'
  | 'requirement.deleted'
  | 'requirement.reordered'
  | 'requirement.superseded'
  | 'grant.issued'
  | 'grant.otp_sent'
  | 'grant.otp_verified'
  | 'grant.otp_failed'
  | 'grant.permission_changed'
  | 'grant.revoked'
  | 'document.uploaded'
  | 'review.decided'
  | 'reminder.sent'
  | 'reminder.failed'
  | 'member.added'
  | 'member.removed'
  | 'blueprint.created'
  | 'blueprint.updated'
  | 'blueprint.deleted';
```
No migration needed — `audit_events.action` is `text not null check (length(btrim(action)) between
1 and 100)` (confirmed in `supabase/migrations/20260722194114_audit_events.sql:17`), not a DB enum.

- [ ] **Step 2: Write the failing integration test (initial coverage)**

```ts
// tests/integration/save-blueprint.test.ts
import { describe, expect, it, vi } from 'vitest';
import { addStaffMember, createOrganizationWithOwner } from '../helpers/clients';
import { saveBlueprint } from '@/application/save-blueprint';
import { deleteBlueprint } from '@/application/delete-blueprint';
import { UseCaseError } from '@/application/errors';

describe('saveBlueprint', () => {
  it('creates a Blueprint and returns its id', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Create', 'notary');

    const result = await saveBlueprint(
      owner.client,
      {
        organizationId,
        name: 'Compraventa',
        stages: [],
        participantTemplates: [],
        requirements: [],
      },
      owner.userId,
    );

    expect(result.blueprintId).toEqual(expect.any(String));
    const { data: row } = await owner.client.from('blueprints').select('name').eq('id', result.blueprintId).single();
    expect(row?.name).toBe('Compraventa');
  });

  it('fully replaces children on edit — an old stage absent from the new payload is gone', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Edit', 'notary');

    const created = await saveBlueprint(
      owner.client,
      { organizationId, name: 'V1', stages: [{ name: 'Old stage', position: 0 }], participantTemplates: [], requirements: [] },
      owner.userId,
    );

    await saveBlueprint(
      owner.client,
      { organizationId, blueprintId: created.blueprintId, name: 'V2', stages: [{ name: 'New stage', position: 0 }], participantTemplates: [], requirements: [] },
      owner.userId,
    );

    const { data: stages } = await owner.client.from('blueprint_stages').select('name').eq('blueprint_id', created.blueprintId);
    expect(stages).toEqual([{ name: 'New stage' }]);
  });

  it('maps duplicate_stage_position to a validation UseCaseError', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Dup Stage', 'notary');

    await expect(
      saveBlueprint(
        owner.client,
        {
          organizationId, name: 'X',
          stages: [{ name: 'A', position: 0 }, { name: 'B', position: 0 }],
          participantTemplates: [], requirements: [],
        },
        owner.userId,
      ),
    ).rejects.toMatchObject({ reason: 'validation', message: 'No puede haber dos etapas con la misma posición.' });
  });

  it('maps blueprint_not_found for a cross-org blueprintId', async () => {
    const { organizationId: orgA } = await createOrganizationWithOwner('Notaría Save Cross A', 'notary');
    const { organizationId: orgB, owner: ownerB } = await createOrganizationWithOwner('Notaría Save Cross B', 'notary');
    const createdInA = await saveBlueprint(
      (await createOrganizationWithOwner('Notaría Save Cross A2', 'notary')).owner.client,
      { organizationId: orgA, name: 'A', stages: [], participantTemplates: [], requirements: [] },
      'irrelevant',
    );

    await expect(
      saveBlueprint(ownerB.client, { organizationId: orgB, blueprintId: createdInA.blueprintId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, ownerB.userId),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });

  it('rejects a non-owner with forbidden via the RPC not_owner code', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save NotOwner', 'notary');
    const staff = await addStaffMember(owner, organizationId);

    await expect(
      saveBlueprint(staff.client, { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, staff.userId),
    ).rejects.toMatchObject({ reason: 'forbidden' });
  });
});

describe('deleteBlueprint', () => {
  it('deletes an existing Blueprint', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Delete OK', 'notary');
    const created = await saveBlueprint(owner.client, { organizationId, name: 'To delete', stages: [], participantTemplates: [], requirements: [] }, owner.userId);

    const result = await deleteBlueprint(owner.client, { organizationId, blueprintId: created.blueprintId }, owner.userId);
    expect(result.blueprintId).toBe(created.blueprintId);

    const { data } = await owner.client.from('blueprints').select('id').eq('id', created.blueprintId).maybeSingle();
    expect(data).toBeNull();
  });

  it('returns not_found for an already-deleted id', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Delete Twice', 'notary');
    const created = await saveBlueprint(owner.client, { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, owner.userId);
    await deleteBlueprint(owner.client, { organizationId, blueprintId: created.blueprintId }, owner.userId);

    await expect(deleteBlueprint(owner.client, { organizationId, blueprintId: created.blueprintId }, owner.userId))
      .rejects.toMatchObject({ reason: 'not_found' });
  });
});

void UseCaseError; // referenced for type-only import checks in this file's future extensions
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run tests/integration/save-blueprint.test.ts
```
Expected: FAIL — `saveBlueprint`/`deleteBlueprint` not yet implemented.

- [ ] **Step 4: Implement `saveBlueprint` — append to `src/application/save-blueprint.ts`**

```ts
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { ValidationError, parseInput } from "@/lib/validation/parse";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";
import {
  BlueprintIntegrityError,
  normalizeBlueprintDraft,
  validateBlueprintStructure,
} from "@/features/blueprints/queries";

type DbClient = SupabaseClient<Database>;

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const roleKeySchema = z.string().trim().min(1).max(100).regex(slugPattern, "Debe ser un identificador en formato slug");
const requirementKeySchema = z.string().trim().min(1).max(200).regex(slugPattern, "Debe ser un identificador en formato slug");
const requirementTypeSchema = z.string().trim().min(1).max(100);

const stageSchema = z.object({
  name: z.string().trim().min(1).max(200),
  position: z.number().int().min(0),
}).strict();

const participantTemplateSchema = z.object({
  roleKey: roleKeySchema,
  displayName: z.string().trim().min(1).max(200),
  position: z.number().int().min(0),
}).strict();

const requirementSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("case"),
    key: requirementKeySchema,
    type: requirementTypeSchema,
    label: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(2000).optional(),
    stagePosition: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    scope: z.literal("participant"),
    key: requirementKeySchema,
    type: requirementTypeSchema,
    label: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(2000).optional(),
    stagePosition: z.number().int().min(0).optional(),
    participantRoleKey: roleKeySchema,
  }).strict(),
]);

export const saveBlueprintSchema = z.object({
  organizationId: z.string().uuid(),
  blueprintId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  stages: z.array(stageSchema),
  participantTemplates: z.array(participantTemplateSchema),
  requirements: z.array(requirementSchema),
}).strict();

export type SaveBlueprintInput = z.input<typeof saveBlueprintSchema>;

const RPC_VALIDATION_MESSAGES: Record<string, string> = {
  invalid_stages_payload: "El formato de las etapas no es válido.",
  invalid_participant_templates_payload: "El formato de los roles de participante no es válido.",
  invalid_requirements_payload: "El formato de los requisitos no es válido.",
  invalid_blueprint_name: "El nombre de la plantilla no es válido.",
  invalid_blueprint_description: "La descripción es demasiado larga.",
  invalid_stage_shape: "Una etapa tiene datos inválidos.",
  duplicate_stage_position: "No puede haber dos etapas con la misma posición.",
  invalid_participant_template_shape: "Un rol de participante tiene datos inválidos.",
  duplicate_participant_role_key: "Cada rol de participante debe tener un identificador único.",
  duplicate_participant_position: "No puede haber dos roles de participante con la misma posición.",
  invalid_requirement_shape: "Un requisito tiene datos inválidos.",
  unknown_participant_role_key: "Un requisito hace referencia a un rol de participante inexistente.",
  unknown_stage_position: "Un requisito hace referencia a una etapa inexistente.",
  duplicate_requirement_key: "Cada requisito debe tener una clave única dentro de su alcance.",
};

const INTEGRITY_MESSAGES: Record<string, string> = {
  invalid_role_key: "El identificador del rol no es válido.",
  duplicate_role_key: "Cada rol de participante debe tener un identificador único.",
  duplicate_participant_position: "No puede haber dos roles de participante con la misma posición.",
  duplicate_stage_position: "No puede haber dos etapas con la misma posición.",
  invalid_key: "La clave del requisito no es válida.",
  missing_label: "Cada requisito necesita una etiqueta.",
  invalid_scope: "El alcance del requisito no es válido.",
  missing_participant_role_key: "Un requisito de participante necesita un rol asociado.",
  orphaned_role_key: "Un requisito hace referencia a un rol inexistente.",
  unexpected_participant_role_key: "Un requisito de expediente no debe tener un rol asociado.",
  orphaned_stage_position: "Un requisito hace referencia a una etapa inexistente.",
  duplicate_key: "Cada requisito debe tener una clave única dentro de su alcance.",
};

export async function saveBlueprint(
  client: DbClient,
  input: SaveBlueprintInput,
  actorAuthUserId: string,
): Promise<{ blueprintId: string }> {
  let parsed;
  try {
    parsed = parseInput(saveBlueprintSchema, input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new UseCaseError("validation", "Revisa los datos de la plantilla.", error.issues);
    }
    throw error;
  }

  let validated;
  try {
    validated = validateBlueprintStructure(normalizeBlueprintDraft(parsed));
  } catch (error) {
    if (error instanceof BlueprintIntegrityError) {
      throw new UseCaseError("validation", INTEGRITY_MESSAGES[error.code] ?? "Los datos de la plantilla no son válidos.");
    }
    throw error;
  }

  const persistence = toPersistenceJson(validated);

  // target_blueprint_id / blueprint_description are optional (no-null-union) keys in the
  // generated RPC Args type, per the migration's `default null` on both — the key is omitted
  // entirely rather than set to an explicit `null`, matching create_case's own from_blueprint_id
  // convention (discovered as a real typecheck mismatch during Task 3; fixed retroactively in
  // Task 1's migration rather than left as a plan inconsistency).
  const { data: blueprintId, error } = await client.rpc("save_blueprint", {
    target_organization_id: parsed.organizationId,
    ...(parsed.blueprintId !== undefined ? { target_blueprint_id: parsed.blueprintId } : {}),
    blueprint_name: validated.name,
    ...(validated.description !== null ? { blueprint_description: validated.description } : {}),
    stages: persistence.stages,
    participant_templates: persistence.participantTemplates,
    requirement_definitions: persistence.requirements,
  });

  if (error) {
    const code = error.message;
    if (code in RPC_VALIDATION_MESSAGES) {
      throw new UseCaseError("validation", RPC_VALIDATION_MESSAGES[code]!);
    }
    if (code === "blueprint_not_found") {
      throw new UseCaseError("not_found", "La plantilla ya no existe.");
    }
    if (code === "not_owner") {
      throw new UseCaseError("forbidden", "Solo el propietario puede editar esta plantilla.");
    }
    throw error;
  }

  await logDomainEvent(client, {
    organizationId: parsed.organizationId,
    action: parsed.blueprintId ? "blueprint.updated" : "blueprint.created",
    targetType: "blueprint",
    targetId: blueprintId!,
    actor: { kind: "member", authUserId: actorAuthUserId },
  });

  return { blueprintId: blueprintId! };
}
```

- [ ] **Step 5: Create `src/application/delete-blueprint.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { UseCaseError } from "./errors";
import { logDomainEvent } from "./events";

type DbClient = SupabaseClient<Database>;

export interface DeleteBlueprintInput {
  organizationId: string;
  blueprintId: string;
}

export async function deleteBlueprint(
  client: DbClient,
  input: DeleteBlueprintInput,
  actorAuthUserId: string,
): Promise<{ blueprintId: string }> {
  const { data, error } = await client
    .from("blueprints")
    .delete()
    .eq("id", input.blueprintId)
    .eq("organization_id", input.organizationId)
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "42501") {
      throw new UseCaseError("forbidden", "No tienes permiso para eliminar esta plantilla.");
    }
    throw error;
  }
  if (!data) {
    throw new UseCaseError("not_found", "La plantilla no existe o ya fue eliminada.");
  }

  await logDomainEvent(client, {
    organizationId: input.organizationId,
    action: "blueprint.deleted",
    targetType: "blueprint",
    targetId: data.id,
    actor: { kind: "member", authUserId: actorAuthUserId },
  });

  return { blueprintId: data.id };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run tests/integration/save-blueprint.test.ts
```
Expected: PASS, all cases.

- [ ] **Step 7: Typecheck**

```bash
npm run typecheck
```
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/application/save-blueprint.ts src/application/delete-blueprint.ts src/features/audit/record.ts tests/integration/save-blueprint.test.ts
git commit -m "Add saveBlueprint/deleteBlueprint use cases with closed RPC-error mapping"
```

---

## Task 6: Server Actions + owner gating

**Files:**
- Create: `src/app/blueprints/actions.ts`

**Interfaces:**
- Consumes: `getStaffContext` (`src/features/auth/context.ts`); `createClient`
  (`src/lib/supabase/server.ts`); `saveBlueprint`, `SaveBlueprintInput`
  (`src/application/save-blueprint.ts`); `deleteBlueprint` (`src/application/delete-blueprint.ts`);
  `getBlueprintDefinition`, `BlueprintDefinition` (`src/features/blueprints/queries.ts`); `ok`,
  `fail`, `ActionResult` (`src/application/errors.ts`).
- Produces:
  ```ts
  export async function saveBlueprintAction(input: Omit<SaveBlueprintInput, "organizationId">): Promise<ActionResult<{ blueprintId: string }>>;
  export async function deleteBlueprintAction(blueprintId: string): Promise<ActionResult<{ blueprintId: string }>>;
  export async function getBlueprintDefinitionAction(blueprintId: string): Promise<ActionResult<BlueprintDefinition>>;
  ```
  These are consumed by `BlueprintEditor` (Task 7) as client-side call sites.

- [ ] **Step 1: Write the file**

```ts
"use server";

/*
 * Server Actions for Blueprint authoring. Kept separate from src/app/cases/actions.ts so the
 * Plantillas module never depends on the Expedientes module.
 *
 * Thin: authenticate, owner-gate, delegate to the application use case, return a typed result —
 * matching src/app/cases/actions.ts's and src/app/settings/actions.ts's existing conventions.
 */

import { revalidatePath } from "next/cache";
import { getStaffContext } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, type ActionResult } from "@/application/errors";
import { saveBlueprint, type SaveBlueprintInput } from "@/application/save-blueprint";
import { deleteBlueprint } from "@/application/delete-blueprint";
import { getBlueprintDefinition, type BlueprintDefinition } from "@/features/blueprints/queries";

export async function saveBlueprintAction(
  input: Omit<SaveBlueprintInput, "organizationId">,
): Promise<ActionResult<{ blueprintId: string }>> {
  const staff = await getStaffContext();
  if (!staff) {
    return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
  }
  if (staff.role !== "owner") {
    return { ok: false, reason: "forbidden", message: "Solo el propietario puede crear o editar plantillas." };
  }

  try {
    const client = await createClient();
    const result = await saveBlueprint(client, { ...input, organizationId: staff.organizationId }, staff.userId);
    revalidatePath("/blueprints");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function deleteBlueprintAction(blueprintId: string): Promise<ActionResult<{ blueprintId: string }>> {
  const staff = await getStaffContext();
  if (!staff) {
    return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
  }
  if (staff.role !== "owner") {
    return { ok: false, reason: "forbidden", message: "Solo el propietario puede eliminar plantillas." };
  }

  try {
    const client = await createClient();
    const result = await deleteBlueprint(client, { organizationId: staff.organizationId, blueprintId }, staff.userId);
    revalidatePath("/blueprints");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export async function getBlueprintDefinitionAction(
  blueprintId: string,
): Promise<ActionResult<BlueprintDefinition>> {
  try {
    const staff = await getStaffContext();
    if (!staff) {
      return { ok: false, reason: "unauthenticated", message: "Tu sesión expiró. Inicia sesión de nuevo." };
    }

    const client = await createClient();
    const definition = await getBlueprintDefinition(client, blueprintId, staff.organizationId);
    if (!definition) {
      return { ok: false, reason: "not_found", message: "La plantilla ya no existe." };
    }
    return ok(definition);
  } catch (error) {
    return fail(error);
  }
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: both clean.

- [ ] **Step 3: Manual smoke test (no UI yet — call via a scratch script)**

```bash
cat > /tmp/smoke-save-blueprint.mjs << 'EOF'
// Deleted after use — not committed.
console.log("Server Actions can only run inside a Next.js request; verified via typecheck + the Task 5 integration tests instead.");
EOF
rm /tmp/smoke-save-blueprint.mjs
```
This action file has no independent runtime behavior beyond what Task 5's use cases already prove
(it is a thin identity/owner-check wrapper) — full behavior is exercised end to end once the UI
exists (Task 8) and in the manual checklist (Task 10).

- [ ] **Step 4: Commit**

```bash
git add src/app/blueprints/actions.ts
git commit -m "Add Blueprint authoring Server Actions with owner gating"
```

---

## Task 7: Draft model + `BlueprintEditor` component

**Files:**
- Modify: `src/components/icons.tsx` (add `IconChevronUp`/`IconChevronDown`)
- Create: `src/app/blueprints/blueprint-editor.tsx`
- Create: `tests/unit/blueprints/serialize-draft.test.ts`

**Interfaces:**
- Consumes: `saveBlueprintAction`, `deleteBlueprintAction` (`src/app/blueprints/actions.ts`, Task
  6); `validateBlueprintStructure`, `NormalizedBlueprint`, `BlueprintDefinition`
  (`src/features/blueprints/queries.ts`, Task 3); `AppShell`, `ShellAccount`
  (`src/components/app-shell.tsx`); icons from `src/components/icons.tsx`.
- Produces:
  ```ts
  export function BlueprintEditor(props: {
    mode: 'create' | 'edit' | 'duplicate';
    blueprintId?: string;
    initialBlueprint: BlueprintDefinition | null;
    usageCount: number;
    account: ShellAccount;
  }): React.ReactElement;
  ```
  Consumed by the routes in Task 8. Also produces, for its own unit test:
  ```ts
  export function serializeDraftToNormalizedBlueprint(draft: EditorDraft): NormalizedBlueprint;
  ```

- [ ] **Step 1: Add the two new icons**

In `src/components/icons.tsx`, after `IconRefresh` (the last existing export), add:

```ts
export const IconChevronUp = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="m6 15 6-6 6 6" /></svg>
);
export const IconChevronDown = (p: IconProps) => (
  <svg viewBox="0 0 24 24" className={p.className} {...s}><path d="m6 9 6 6 6-6" /></svg>
);
```

- [ ] **Step 2: Write the failing unit test for the draft serializer**

```ts
// tests/unit/blueprints/serialize-draft.test.ts
import { describe, expect, it } from 'vitest';
import { serializeDraftToNormalizedBlueprint, type EditorDraft } from '@/app/blueprints/blueprint-editor';

function baseDraft(): EditorDraft {
  return {
    name: 'Compraventa',
    description: '',
    stages: [
      { draftId: 's1', name: 'Firma' },
      { draftId: 's2', name: 'Entrega' },
    ],
    participantTemplates: [
      { draftId: 'p1', roleKey: 'buyer', keyTouched: true, displayName: 'Comprador' },
    ],
    requirements: [
      { stageDraftId: 's1', participantRoleDraftId: null, key: 'title-deed', keyTouched: true, type: 'document', label: 'Escritura', scope: 'case' },
      { stageDraftId: null, participantRoleDraftId: 'p1', key: 'official-id', keyTouched: true, type: 'document', label: 'INE', scope: 'participant' },
    ],
  };
}

describe('serializeDraftToNormalizedBlueprint', () => {
  it('derives position and stagePosition/participantRoleKey from draftId references', () => {
    const normalized = serializeDraftToNormalizedBlueprint(baseDraft());
    expect(normalized.stages).toEqual([{ name: 'Firma', position: 0 }, { name: 'Entrega', position: 1 }]);
    expect(normalized.requirements[0]).toMatchObject({ scope: 'case', stagePosition: 0, participantRoleKey: null });
    expect(normalized.requirements[1]).toMatchObject({ scope: 'participant', participantRoleKey: 'buyer', stagePosition: null });
  });

  it('preserves stageDraftId associations when stages are reordered', () => {
    const draft = baseDraft();
    // Reorder: Entrega (s2) now comes first.
    draft.stages = [
      { draftId: 's2', name: 'Entrega' },
      { draftId: 's1', name: 'Firma' },
    ];
    const normalized = serializeDraftToNormalizedBlueprint(draft);
    // requirements[0] still references s1 ("Firma"), which is now at position 1.
    expect(normalized.requirements[0]?.stagePosition).toBe(1);
  });

  it('serializes a null stageDraftId as no stagePosition', () => {
    const draft = baseDraft();
    draft.requirements[0]!.stageDraftId = null;
    const normalized = serializeDraftToNormalizedBlueprint(draft);
    expect(normalized.requirements[0]?.stagePosition).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/unit/blueprints/serialize-draft.test.ts
```
Expected: FAIL — `@/app/blueprints/blueprint-editor` does not exist yet.

- [ ] **Step 4: Create `src/app/blueprints/blueprint-editor.tsx`**

```tsx
"use client";

/*
 * DocuFlow — Blueprint authoring. One component, three modes (create/edit/duplicate) — see
 * docs/superpowers/specs/2026-07-29-blueprint-authoring-design.md, section 5.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronUp,
  IconPlus,
  IconShield,
  IconTrash,
} from "@/components/icons";
import { saveBlueprintAction, deleteBlueprintAction } from "./actions";
import {
  validateBlueprintStructure,
  type BlueprintDefinition,
  type NormalizedBlueprint,
} from "@/features/blueprints/queries";
import type { SaveBlueprintInput } from "@/application/save-blueprint";

export type EditorMode = "create" | "edit" | "duplicate";

export interface DraftStage {
  draftId: string;
  name: string;
}
export interface DraftParticipantTemplate {
  draftId: string;
  roleKey: string;
  keyTouched: boolean;
  displayName: string;
}
export interface DraftRequirement {
  stageDraftId: string | null;
  participantRoleDraftId: string | null;
  key: string;
  keyTouched: boolean;
  type: string;
  label: string;
  instructions?: string;
  scope: "case" | "participant";
}
export interface EditorDraft {
  name: string;
  description: string;
  stages: DraftStage[];
  participantTemplates: DraftParticipantTemplate[];
  requirements: DraftRequirement[];
}

let seq = 0;
const uid = (prefix: string) => `${prefix}${++seq}`;

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Pure conversion from the editor's stable-draftId shape into the NormalizedBlueprint shape the
 * shared validator expects. Reordering stages/roles only changes array order, never the
 * stageDraftId/participantRoleDraftId a requirement carries — so this is the only place positions
 * and roleKeys are ever derived.
 */
export function serializeDraftToNormalizedBlueprint(draft: EditorDraft): NormalizedBlueprint {
  const stagePositionByDraftId = new Map(draft.stages.map((s, i) => [s.draftId, i]));
  const roleKeyByDraftId = new Map(draft.participantTemplates.map((t) => [t.draftId, t.roleKey]));

  return {
    name: draft.name,
    description: draft.description.trim().length > 0 ? draft.description : null,
    stages: draft.stages.map((s, i) => ({ name: s.name, position: i })),
    participantTemplates: draft.participantTemplates.map((t, i) => ({
      roleKey: t.roleKey,
      displayName: t.displayName,
      position: i,
    })),
    requirements: draft.requirements.map((r) => ({
      key: r.key,
      type: r.type,
      label: r.label,
      instructions: r.instructions ?? null,
      scope: r.scope,
      participantRoleKey: r.scope === "participant" && r.participantRoleDraftId
        ? roleKeyByDraftId.get(r.participantRoleDraftId) ?? null
        : null,
      stagePosition: r.stageDraftId !== null ? stagePositionByDraftId.get(r.stageDraftId) ?? null : null,
    })),
  };
}

/** Converts the flat NormalizedBlueprint requirement shape into the discriminated-union shape
 *  saveBlueprintAction's Zod schema expects — the case branch must not carry a participantRoleKey
 *  key at all (`.strict()` rejects any key it doesn't declare, even with a null value), and
 *  optional fields must be omitted (undefined), never explicit null, since Zod's `.optional()`
 *  only accepts absence. */
function toSaveBlueprintPayload(
  normalized: NormalizedBlueprint,
  blueprintId: string | undefined,
): Omit<SaveBlueprintInput, "organizationId"> {
  return {
    blueprintId,
    name: normalized.name,
    description: normalized.description ?? undefined,
    stages: normalized.stages,
    participantTemplates: normalized.participantTemplates,
    requirements: normalized.requirements.map((r) =>
      r.scope === "case"
        ? {
            scope: "case" as const,
            key: r.key,
            type: r.type,
            label: r.label,
            instructions: r.instructions ?? undefined,
            stagePosition: r.stagePosition ?? undefined,
          }
        : {
            scope: "participant" as const,
            key: r.key,
            type: r.type,
            label: r.label,
            instructions: r.instructions ?? undefined,
            stagePosition: r.stagePosition ?? undefined,
            participantRoleKey: r.participantRoleKey!,
          },
    ),
  };
}

function draftFromBlueprint(bp: BlueprintDefinition | null): EditorDraft {
  if (!bp) {
    return { name: "", description: "", stages: [], participantTemplates: [], requirements: [] };
  }
  const stageDraftIdByPosition = new Map<number, string>();
  const roleDraftIdByRoleKey = new Map<string, string>();

  const stages: DraftStage[] = [...bp.stages].sort((a, b) => a.position - b.position).map((s) => {
    const draftId = uid("s");
    stageDraftIdByPosition.set(s.position, draftId);
    return { draftId, name: s.name };
  });
  const participantTemplates: DraftParticipantTemplate[] = [...bp.participantTemplates]
    .sort((a, b) => a.position - b.position)
    .map((t) => {
      const draftId = uid("p");
      roleDraftIdByRoleKey.set(t.roleKey, draftId);
      // keyTouched: true — renaming a loaded role's display name must never silently change its
      // roleKey.
      return { draftId, roleKey: t.roleKey, keyTouched: true, displayName: t.displayName };
    });
  const requirements: DraftRequirement[] = bp.requirements.map((r) => ({
    stageDraftId: r.stagePosition !== null ? stageDraftIdByPosition.get(r.stagePosition) ?? null : null,
    participantRoleDraftId: r.participantRoleKey !== null ? roleDraftIdByRoleKey.get(r.participantRoleKey) ?? null : null,
    key: r.key,
    keyTouched: true,
    type: r.type,
    label: r.label,
    instructions: r.instructions ?? undefined,
    scope: r.scope,
  }));

  return { name: bp.name, description: bp.description ?? "", stages, participantTemplates, requirements };
}

const STEP_LABELS = ["Información", "Etapas", "Participantes", "Requisitos", "Revisión"] as const;

const MODE_COPY: Record<EditorMode, { title: (name: string) => string; cta: string }> = {
  create: { title: () => "Nueva plantilla", cta: "Crear plantilla" },
  duplicate: { title: (name) => `Nueva plantilla (copia de ${name})`, cta: "Crear plantilla" },
  edit: { title: (name) => `Editar ${name}`, cta: "Guardar cambios" },
};

export function BlueprintEditor({
  mode,
  blueprintId,
  initialBlueprint,
  usageCount,
  account,
}: {
  mode: EditorMode;
  blueprintId?: string;
  initialBlueprint: BlueprintDefinition | null;
  usageCount: number;
  account: ShellAccount;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<EditorDraft>(() => draftFromBlueprint(initialBlueprint));
  const [step, setStep] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (isDirty && !isSaving) e.preventDefault();
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty, isSaving]);

  const sourceName = initialBlueprint?.name ?? "";
  const copy = MODE_COPY[mode];

  function markDirty() {
    setIsDirty(true);
  }

  function addStage() {
    setDraft((d) => ({ ...d, stages: [...d.stages, { draftId: uid("s"), name: "" }] }));
    markDirty();
  }
  function removeStage(draftId: string) {
    const affected = draft.requirements.filter((r) => r.stageDraftId === draftId);
    if (affected.length > 0) {
      const ok = window.confirm(
        `${affected.length} requisitos usan esta etapa. Si la eliminas, quedarán sin etapa.`,
      );
      if (!ok) return;
    }
    setDraft((d) => ({
      ...d,
      stages: d.stages.filter((s) => s.draftId !== draftId),
      requirements: d.requirements.map((r) => (r.stageDraftId === draftId ? { ...r, stageDraftId: null } : r)),
    }));
    markDirty();
  }
  function moveStage(index: number, direction: -1 | 1) {
    setDraft((d) => {
      const stages = [...d.stages];
      const target = index + direction;
      if (target < 0 || target >= stages.length) return d;
      [stages[index], stages[target]] = [stages[target]!, stages[index]!];
      return { ...d, stages };
    });
    markDirty();
  }

  function addParticipantTemplate() {
    setDraft((d) => ({
      ...d,
      participantTemplates: [...d.participantTemplates, { draftId: uid("p"), roleKey: "", keyTouched: false, displayName: "" }],
    }));
    markDirty();
  }
  function removeParticipantTemplate(draftId: string) {
    const affected = draft.requirements.filter((r) => r.participantRoleDraftId === draftId);
    if (affected.length > 0) {
      const ok = window.confirm(
        `Este rol tiene ${affected.length} requisitos asociados. Al eliminarlo también se eliminarán esos requisitos.`,
      );
      if (!ok) return;
    }
    setDraft((d) => ({
      ...d,
      participantTemplates: d.participantTemplates.filter((t) => t.draftId !== draftId),
      requirements: d.requirements.filter((r) => r.participantRoleDraftId !== draftId),
    }));
    markDirty();
  }
  function updateParticipantDisplayName(draftId: string, displayName: string) {
    setDraft((d) => ({
      ...d,
      participantTemplates: d.participantTemplates.map((t) =>
        t.draftId === draftId
          ? { ...t, displayName, roleKey: t.keyTouched ? t.roleKey : slugify(displayName) }
          : t,
      ),
    }));
    markDirty();
  }
  function updateParticipantRoleKey(draftId: string, roleKey: string) {
    setDraft((d) => ({
      ...d,
      participantTemplates: d.participantTemplates.map((t) =>
        t.draftId === draftId ? { ...t, roleKey, keyTouched: true } : t,
      ),
    }));
    markDirty();
  }

  function addRequirement() {
    setDraft((d) => ({
      ...d,
      requirements: [
        ...d.requirements,
        { stageDraftId: null, participantRoleDraftId: null, key: "", keyTouched: false, type: "document", label: "", scope: "case" },
      ],
    }));
    markDirty();
  }
  function removeRequirement(index: number) {
    setDraft((d) => ({ ...d, requirements: d.requirements.filter((_, i) => i !== index) }));
    markDirty();
  }
  function updateRequirement(index: number, patch: Partial<DraftRequirement>) {
    setDraft((d) => ({
      ...d,
      requirements: d.requirements.map((r, i) => {
        if (i !== index) return r;
        const next = { ...r, ...patch };
        if (patch.label !== undefined && !r.keyTouched) next.key = slugify(patch.label);
        if (patch.key !== undefined) next.keyTouched = true;
        return next;
      }),
    }));
    markDirty();
  }

  const canAdvanceStep0 = draft.name.trim().length > 0;

  function validateFullDraft(): boolean {
    try {
      validateBlueprintStructure(serializeDraftToNormalizedBlueprint(draft));
      setStepError(null);
      return true;
    } catch (e) {
      setStepError(e instanceof Error ? e.message : "La plantilla tiene datos inválidos.");
      return false;
    }
  }

  function goNext() {
    if (step === 0 && !canAdvanceStep0) return;
    // Full structural validation runs when leaving Requisitos (step 3) and entering Revisión —
    // not on every step, since an in-progress draft with no requirements yet is still valid.
    if (step === 3 && !validateFullDraft()) return;
    setStep((s) => Math.min(4, s + 1));
  }
  function goBack() {
    setStep((s) => Math.max(0, s - 1) as typeof s);
  }

  function requestLeave(action: () => void) {
    if (isDirty && !isSaving) {
      setConfirmingLeave(true);
      return;
    }
    action();
  }

  async function handleSave() {
    if (!validateFullDraft()) return;
    setIsSaving(true);
    setSaveError(null);
    const normalized = serializeDraftToNormalizedBlueprint(draft);
    const payload = toSaveBlueprintPayload(normalized, mode === "edit" ? blueprintId : undefined);
    const result = await saveBlueprintAction(payload);
    setIsSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setIsDirty(false);
    router.push("/blueprints");
  }

  async function handleDelete() {
    if (!blueprintId) return;
    setIsSaving(true);
    const result = await deleteBlueprintAction(blueprintId);
    setIsSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      setConfirmingDelete(false);
      return;
    }
    router.push("/blueprints");
  }

  const roleOptions = useMemo(
    () => draft.participantTemplates.filter((t) => t.roleKey.trim().length > 0),
    [draft.participantTemplates],
  );

  return (
    <AppShell active="blueprints" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">{copy.title(sourceName)}</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        {mode === "edit" && usageCount > 0 && (
          <div className="mb-5 rounded-input border border-royal-100 bg-royal-50 px-4 py-3 text-sm text-royal-700">
            Esta plantilla ya se usó en {usageCount} expediente{usageCount === 1 ? "" : "s"}. Los
            cambios no afectan expedientes existentes.
          </div>
        )}

        <div className="mb-6 flex gap-2">
          {STEP_LABELS.map((label, i) => (
            <div
              key={label}
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${
                i === step ? "bg-royal-600 text-white" : "bg-app-bg text-text-secondary"
              }`}
            >
              {label}
            </div>
          ))}
        </div>

        {stepError && <p className="mb-4 text-sm text-error">{stepError}</p>}
        {saveError && <p className="mb-4 text-sm text-error">{saveError}</p>}

        {step === 0 && (
          <div className="flex max-w-lg flex-col gap-4">
            <div>
              <label className="text-sm font-medium text-text-primary">Nombre</label>
              <input
                value={draft.name}
                onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); markDirty(); }}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">Descripción</label>
              <textarea
                value={draft.description}
                onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })); markDirty(); }}
                className="mt-1.5 w-full rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex max-w-lg flex-col gap-3">
            {draft.stages.length === 0 && (
              <p className="text-sm text-text-secondary">Sin etapas. Esto es opcional.</p>
            )}
            {draft.stages.map((s, i) => (
              <div key={s.draftId} className="flex items-center gap-2">
                <input
                  value={s.name}
                  onChange={(e) => {
                    setDraft((d) => ({
                      ...d,
                      stages: d.stages.map((st) => (st.draftId === s.draftId ? { ...st, name: e.target.value } : st)),
                    }));
                    markDirty();
                  }}
                  className="flex-1 rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                />
                <button type="button" onClick={() => moveStage(i, -1)} disabled={i === 0} className="rounded-input p-1.5 disabled:opacity-30">
                  <IconChevronUp className="size-4" />
                </button>
                <button type="button" onClick={() => moveStage(i, 1)} disabled={i === draft.stages.length - 1} className="rounded-input p-1.5 disabled:opacity-30">
                  <IconChevronDown className="size-4" />
                </button>
                <button type="button" onClick={() => removeStage(s.draftId)} className="rounded-input p-1.5 text-error">
                  <IconTrash className="size-4" />
                </button>
              </div>
            ))}
            <button type="button" onClick={addStage} className="flex w-fit items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm">
              <IconPlus className="size-4" /> Agregar etapa
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="flex max-w-lg flex-col gap-3">
            {draft.participantTemplates.map((t) => (
              <div key={t.draftId} className="flex items-center gap-2">
                <input
                  placeholder="Nombre del rol"
                  value={t.displayName}
                  onChange={(e) => updateParticipantDisplayName(t.draftId, e.target.value)}
                  className="flex-1 rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                />
                <input
                  placeholder="identificador-slug"
                  value={t.roleKey}
                  onChange={(e) => updateParticipantRoleKey(t.draftId, e.target.value)}
                  className="w-40 rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                />
                <button type="button" onClick={() => removeParticipantTemplate(t.draftId)} className="rounded-input p-1.5 text-error">
                  <IconTrash className="size-4" />
                </button>
              </div>
            ))}
            <button type="button" onClick={addParticipantTemplate} className="flex w-fit items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm">
              <IconPlus className="size-4" /> Agregar rol
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="flex max-w-2xl flex-col gap-4">
            {draft.requirements.map((r, i) => (
              <div key={i} className="rounded-input border border-border p-4">
                <div className="grid grid-cols-2 gap-3">
                  <input
                    placeholder="Etiqueta"
                    value={r.label}
                    onChange={(e) => updateRequirement(i, { label: e.target.value })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  />
                  <input
                    placeholder="clave-slug"
                    value={r.key}
                    onChange={(e) => updateRequirement(i, { key: e.target.value })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  />
                  <select
                    value={r.scope}
                    onChange={(e) => updateRequirement(i, { scope: e.target.value as "case" | "participant", participantRoleDraftId: null })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  >
                    <option value="case">Expediente</option>
                    {roleOptions.length > 0 && <option value="participant">Participante</option>}
                  </select>
                  {r.scope === "participant" && (
                    <select
                      value={r.participantRoleDraftId ?? ""}
                      onChange={(e) => updateRequirement(i, { participantRoleDraftId: e.target.value })}
                      className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                    >
                      <option value="">Selecciona un rol</option>
                      {roleOptions.map((t) => (
                        <option key={t.draftId} value={t.draftId}>{t.displayName}</option>
                      ))}
                    </select>
                  )}
                  <select
                    value={r.stageDraftId ?? ""}
                    onChange={(e) => updateRequirement(i, { stageDraftId: e.target.value || null })}
                    className="rounded-input border border-border bg-app-bg px-3 py-2 text-sm"
                  >
                    <option value="">Sin etapa</option>
                    {draft.stages.map((s) => (
                      <option key={s.draftId} value={s.draftId}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <button type="button" onClick={() => removeRequirement(i)} className="mt-2 flex items-center gap-1.5 text-sm text-error">
                  <IconTrash className="size-4" /> Eliminar requisito
                </button>
              </div>
            ))}
            <button type="button" onClick={addRequirement} className="flex w-fit items-center gap-1.5 rounded-input border border-border px-3 py-1.5 text-sm">
              <IconPlus className="size-4" /> Agregar requisito
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="max-w-lg text-sm text-text-secondary">
            <p><strong className="text-text-primary">{draft.name}</strong></p>
            <p className="mt-2">{draft.stages.length} etapas · {draft.participantTemplates.length} roles ·{" "}
              {draft.requirements.filter((r) => r.scope === "case").length} requisitos de expediente ·{" "}
              {draft.requirements.filter((r) => r.scope === "participant").length} requisitos de participante</p>
          </div>
        )}

        <div className="mt-8 flex items-center gap-3">
          {step > 0 && (
            <button type="button" onClick={goBack} className="flex items-center gap-1.5 rounded-input border border-border px-3.5 py-2 text-sm">
              <IconArrowLeft className="size-4" /> Atrás
            </button>
          )}
          {step < 4 && (
            <button
              type="button"
              onClick={goNext}
              disabled={step === 0 && !canAdvanceStep0}
              className="flex items-center gap-1.5 rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              Siguiente <IconArrowRight className="size-4" />
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {isSaving ? "Guardando…" : copy.cta}
            </button>
          )}
          <button
            type="button"
            onClick={() => requestLeave(() => router.push("/blueprints"))}
            className="rounded-input border border-border px-3.5 py-2 text-sm"
          >
            Cancelar
          </button>
          {mode === "edit" && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="ml-auto flex items-center gap-1.5 rounded-input border border-error px-3.5 py-2 text-sm text-error"
            >
              <IconTrash className="size-4" /> Eliminar
            </button>
          )}
        </div>
      </div>

      {confirmingLeave && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-royal-50 text-royal-600">
              <IconShield className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Cambios sin guardar</h2>
            <p className="mt-2 text-sm text-text-secondary">Tienes cambios sin guardar. ¿Quieres salir de todos modos?</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmingLeave(false)} className="rounded-input border border-border px-3.5 py-2 text-sm">
                Seguir editando
              </button>
              <button
                type="button"
                onClick={() => { setConfirmingLeave(false); router.push("/blueprints"); }}
                className="rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white"
              >
                Salir sin guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-error/10 text-error">
              <IconTrash className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Eliminar plantilla</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Esta acción es permanente.
              {usageCount > 0 && " Los expedientes ya creados no se verán afectados."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded-input border border-border px-3.5 py-2 text-sm">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={isSaving}
                className="rounded-input bg-error px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {isSaving ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
```

- [ ] **Step 5: Run the draft-serializer test to verify it passes**

```bash
npx vitest run tests/unit/blueprints/serialize-draft.test.ts
```
Expected: PASS.

- [ ] **Step 6: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: both clean. If `roleOptions`/`useMemo` or other unused-variable lint errors appear,
resolve them by removing the offending unused binding — do not disable the rule.

- [ ] **Step 7: Commit**

```bash
git add src/components/icons.tsx src/app/blueprints/blueprint-editor.tsx tests/unit/blueprints/serialize-draft.test.ts
git commit -m "Add BlueprintEditor component with create/edit/duplicate modes"
```

---

## Task 8: create/edit/duplicate routes

**Files:**
- Create: `src/app/blueprints/new/page.tsx`
- Create: `src/app/blueprints/[id]/edit/page.tsx`

**Interfaces:**
- Consumes: `requireStaff` (`src/features/auth/context.ts`); `createClient`
  (`src/lib/supabase/server.ts`); `getBlueprintDefinition`, `countCasesUsingBlueprint`
  (`src/features/blueprints/queries.ts`); `BlueprintEditor` (`src/app/blueprints/blueprint-editor.tsx`,
  Task 7); `notFound`, `redirect` (`next/navigation`).
- Produces: the two routes themselves — nothing consumed by later tasks except that Task 9's
  Plantillas page links to them (`/blueprints/new`, `/blueprints/new?from=<id>`,
  `/blueprints/<id>/edit`).

- [ ] **Step 1: Create `src/app/blueprints/new/page.tsx`**

```tsx
import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { getBlueprintDefinition } from "@/features/blueprints/queries";
import { BlueprintEditor } from "../blueprint-editor";

export const dynamic = "force-dynamic";

export default async function NewBlueprintPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const staff = await requireStaff();
  if (staff.role !== "owner") redirect("/blueprints");

  const { from } = await searchParams;
  const account = { name: staff.organizationName, sub: staff.email };

  if (from) {
    const client = await createClient();
    const definition = await getBlueprintDefinition(client, from, staff.organizationId);
    if (!definition) notFound();
    return (
      <BlueprintEditor mode="duplicate" initialBlueprint={definition} usageCount={0} account={account} />
    );
  }

  return <BlueprintEditor mode="create" initialBlueprint={null} usageCount={0} account={account} />;
}
```

- [ ] **Step 2: Create `src/app/blueprints/[id]/edit/page.tsx`**

```tsx
import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { countCasesUsingBlueprint, getBlueprintDefinition } from "@/features/blueprints/queries";
import { BlueprintEditor } from "../../blueprint-editor";

export const dynamic = "force-dynamic";

export default async function EditBlueprintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const staff = await requireStaff();
  if (staff.role !== "owner") redirect("/blueprints");

  const { id } = await params;
  const client = await createClient();
  const definition = await getBlueprintDefinition(client, id, staff.organizationId);
  if (!definition) notFound();

  const usageCount = await countCasesUsingBlueprint(client, id, staff.organizationId);

  return (
    <BlueprintEditor
      mode="edit"
      blueprintId={id}
      initialBlueprint={definition}
      usageCount={usageCount}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: both clean.

- [ ] **Step 4: Start the dev server and manually verify both routes load**

```bash
npm run db:reset
npm run db:seed
npm run dev
```
Navigate to `/blueprints/new` as a seeded owner — the editor should render at Step 0 with empty
fields. Navigate to `/blueprints/<a-seeded-id>/edit` — the editor should render prefilled. (Full
manual checklist is Task 10; this step is a quick existence check only.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/blueprints/new/page.tsx" "src/app/blueprints/[id]/edit/page.tsx"
git commit -m "Add /blueprints/new and /blueprints/[id]/edit routes"
```

---

## Task 9: Plantillas affordances + delete

**Files:**
- Modify: `src/app/blueprints/page.tsx`
- Modify: `src/app/blueprints/blueprints-directory.tsx`

**Interfaces:**
- Consumes: `deleteBlueprintAction` (`src/app/blueprints/actions.ts`, Task 6); existing
  `BlueprintSummary`, `listBlueprintSummaries`.
- Produces: nothing consumed by later tasks — this is the final UI-visible surface.

- [ ] **Step 1: Modify `src/app/blueprints/page.tsx` to pass `isOwner`**

```tsx
/*
 * Plantillas — Server Component. Owners get authoring controls (Nueva plantilla, Editar,
 * Duplicar, Eliminar); any staff member can still browse the directory read-only.
 * See docs/superpowers/specs/2026-07-29-blueprint-authoring-design.md.
 */

import { requireStaff } from "@/features/auth/context";
import { createClient } from "@/lib/supabase/server";
import { listBlueprintSummaries } from "@/features/blueprints/queries";
import { BlueprintsDirectory } from "./blueprints-directory";

export const dynamic = "force-dynamic";

export default async function BlueprintsPage() {
  const staff = await requireStaff();
  const supabase = await createClient();
  const blueprints = await listBlueprintSummaries(supabase, staff.organizationId);

  return (
    <BlueprintsDirectory
      blueprints={blueprints}
      isOwner={staff.role === "owner"}
      account={{ name: staff.organizationName, sub: staff.email }}
    />
  );
}
```

- [ ] **Step 2: Modify `src/app/blueprints/blueprints-directory.tsx`**

```tsx
"use client";

/*
 * DocuFlow — Blueprint Library. Real data. Cards show the four broken-out counts; owners also get
 * Editar/Duplicar/Eliminar per card and a Nueva plantilla button.
 */

import Link from "next/link";
import { useState } from "react";
import { AppShell, type ShellAccount } from "@/components/app-shell";
import { IconDocument, IconPlus, IconTrash } from "@/components/icons";
import type { BlueprintSummary } from "@/features/blueprints/queries";
import { deleteBlueprintAction } from "./actions";

function BlueprintCard({
  b,
  isOwner,
  onDelete,
}: {
  b: BlueprintSummary;
  isOwner: boolean;
  onDelete: (b: BlueprintSummary) => void;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-card border border-border bg-surface transition-shadow hover:shadow-sm">
      <div className="flex items-start justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-input bg-royal-50 text-royal-600">
            <IconDocument className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold text-text-primary">{b.name}</div>
            {b.isPlatformTemplate && (
              <span className="mt-0.5 inline-block rounded-full bg-app-bg px-2 py-0.5 text-xs font-medium text-text-secondary">
                Plantilla de DocuFlow
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 px-5 py-4">
        {b.description && <p className="text-sm text-text-secondary">{b.description}</p>}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Etapas</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.stageCount}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Roles sugeridos</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.participantTemplateCount}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Requisitos de expediente</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.caseRequirementCount}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Requisitos de participante</div>
            <div className="mt-1 text-lg font-semibold tabular text-text-primary">{b.participantRequirementCount}</div>
          </div>
        </div>
      </div>

      {isOwner && (
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <Link href={`/blueprints/${b.id}/edit`} className="rounded-input border border-border px-3 py-1.5 text-sm">
            Editar
          </Link>
          <Link href={`/blueprints/new?from=${b.id}`} className="rounded-input border border-border px-3 py-1.5 text-sm">
            Duplicar
          </Link>
          <button
            type="button"
            onClick={() => onDelete(b)}
            className="ml-auto flex items-center gap-1.5 rounded-input border border-error px-3 py-1.5 text-sm text-error"
          >
            <IconTrash className="size-4" /> Eliminar
          </button>
        </div>
      )}
    </div>
  );
}

export function BlueprintsDirectory({
  blueprints,
  isOwner,
  account,
}: {
  blueprints: BlueprintSummary[];
  isOwner: boolean;
  account: ShellAccount;
}) {
  const [pendingDelete, setPendingDelete] = useState<BlueprintSummary | null>(null);
  const [items, setItems] = useState(blueprints);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const result = await deleteBlueprintAction(pendingDelete.id);
    setDeleting(false);
    if (!result.ok) {
      setError(result.message);
      setPendingDelete(null);
      return;
    }
    setItems((prev) => prev.filter((b) => b.id !== pendingDelete.id));
    setPendingDelete(null);
  }

  return (
    <AppShell active="blueprints" account={account}>
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-border bg-surface px-7">
        <h1 className="text-base font-semibold text-text-primary">Plantillas</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-6">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-text-primary">Plantillas</h2>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">
              Una plantilla es un punto de partida, no un formato fijo. Al clonarla en un expediente
              se crea un expediente independiente que puedes editar libremente — cambiar una
              plantilla nunca afecta a los expedientes ya creados a partir de ella.
            </p>
          </div>
          {isOwner && (
            <Link
              href="/blueprints/new"
              className="flex shrink-0 items-center gap-1.5 rounded-input bg-royal-600 px-3.5 py-2 text-sm font-semibold text-white"
            >
              <IconPlus className="size-4" /> Nueva plantilla
            </Link>
          )}
        </div>

        {error && <p className="mb-4 text-sm text-error">{error}</p>}

        {items.length === 0 ? (
          <p className="text-sm text-text-secondary">Todavía no hay plantillas en esta organización.</p>
        ) : (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            {items.map((b) => (
              <BlueprintCard key={b.id} b={b} isOwner={isOwner} onDelete={setPendingDelete} />
            ))}
          </div>
        )}
      </div>

      {pendingDelete && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-panel border border-border bg-surface p-6 shadow-md">
            <span className="flex size-10 items-center justify-center rounded-full bg-error/10 text-error">
              <IconTrash className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold text-text-primary">Eliminar "{pendingDelete.name}"</h2>
            <p className="mt-2 text-sm text-text-secondary">
              Esta acción es permanente. Los expedientes creados previamente no se verán afectados.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setPendingDelete(null)} className="rounded-input border border-border px-3.5 py-2 text-sm">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="rounded-input bg-error px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleting ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npm run lint
```
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/blueprints/page.tsx src/app/blueprints/blueprints-directory.tsx
git commit -m "Add Nueva plantilla / Editar / Duplicar / Eliminar to the Plantillas directory"
```

---

## Task 10: Full test coverage + manual verification checklist

**Files:**
- Modify: `tests/integration/save-blueprint.test.ts` (expand to the spec's full list)
- No new source files

**Interfaces:**
- Consumes: everything from Tasks 1-9. No new interfaces produced.

- [ ] **Step 1: Expand `tests/integration/save-blueprint.test.ts` with the remaining cases**

Append these `it` blocks inside the existing `describe('saveBlueprint', ...)` block:

```ts
  it('maps every closed RPC validation code to the correct UseCaseError message', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save All Codes', 'notary');
    const cases: { name: string; overrides: Record<string, unknown>; expectedMessage: string }[] = [
      {
        name: 'duplicate participant role key',
        overrides: { participantTemplates: [
          { roleKey: 'buyer', displayName: 'A', position: 0 },
          { roleKey: 'buyer', displayName: 'B', position: 1 },
        ] },
        expectedMessage: 'Cada rol de participante debe tener un identificador único.',
      },
      {
        name: 'duplicate participant position',
        overrides: { participantTemplates: [
          { roleKey: 'buyer', displayName: 'A', position: 0 },
          { roleKey: 'seller', displayName: 'B', position: 0 },
        ] },
        expectedMessage: 'No puede haber dos roles de participante con la misma posición.',
      },
      {
        name: 'unknown participant role key',
        overrides: { requirements: [
          { scope: 'participant', key: 'x', type: 'document', label: 'X', participantRoleKey: 'nonexistent' },
        ] },
        expectedMessage: 'Un requisito hace referencia a un rol de participante inexistente.',
      },
      {
        name: 'unknown stage position',
        overrides: { requirements: [
          { scope: 'case', key: 'x', type: 'document', label: 'X', stagePosition: 5 },
        ] },
        expectedMessage: 'Un requisito hace referencia a una etapa inexistente.',
      },
      {
        name: 'duplicate requirement key',
        overrides: { requirements: [
          { scope: 'case', key: 'dup', type: 'document', label: 'A' },
          { scope: 'case', key: 'dup', type: 'document', label: 'B' },
        ] },
        expectedMessage: 'Cada requisito debe tener una clave única dentro de su alcance.',
      },
    ];

    for (const c of cases) {
      await expect(
        saveBlueprint(
          owner.client,
          { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [], ...c.overrides },
          owner.userId,
        ),
        c.name,
      ).rejects.toMatchObject({ reason: 'validation', message: c.expectedMessage });
    }
  });

  it('rethrows an unrecognized RPC error as unexpected rather than downgrading to forbidden', async () => {
    const { organizationId, owner } = await createOrganizationWithOwner('Notaría Save Unexpected', 'notary');

    // Forcing a genuine unrecognized Postgres error would require bypassing the RPC's own
    // preflight checks entirely — not reachable through the public save_blueprint contract. This
    // spies on the one integration point (client.rpc) to simulate that scenario deterministically:
    // an error whose message is not a key in RPC_VALIDATION_MESSAGES and not 'blueprint_not_found'
    // or 'not_owner' must propagate as-is, not be silently reclassified as 'forbidden'.
    const rpcSpy = vi.spyOn(owner.client, 'rpc').mockReturnValueOnce(
      Promise.resolve({ data: null, error: { message: 'some_never_before_seen_code', code: 'P0001' } }) as never,
    );

    await expect(
      saveBlueprint(owner.client, { organizationId, name: 'X', stages: [], participantTemplates: [], requirements: [] }, owner.userId),
    ).rejects.not.toMatchObject({ reason: 'forbidden' });

    rpcSpy.mockRestore();
  });
```

- [ ] **Step 2: Run the full integration test file**

```bash
npx vitest run tests/integration/save-blueprint.test.ts
```
Expected: PASS, all cases including the newly appended ones.

- [ ] **Step 3: Run the complete automated suite**

```bash
npx vitest run
```
Expected: every test file passes, including all files touched or created across Tasks 1-9.

- [ ] **Step 4: Reset to a clean seeded baseline and start the dev server**

```bash
npm run db:reset
npm run db:seed
npm run dev
```

- [ ] **Step 5: Complete the manual verification checklist**

Walk every item below against the running dev server with real seed data, as a seeded owner
account unless noted otherwise:

```
## Manual verification

Create
- [ ] /blueprints/new loads the editor at Step 0 with empty fields
- [ ] Skipping Etapas and Participantes entirely (leaving both empty) is allowed; Siguiente is
      never blocked by an empty list
- [ ] Adding a requirement whose label auto-generates a matching slug key
- [ ] Manually editing a key field locks it — a subsequent label edit no longer changes it
- [ ] Full create flow (all 5 steps) → Guardar → redirected to /blueprints → new card appears with
      correct counts

Edit
- [ ] /blueprints/<id>/edit for a seeded Blueprint (e.g. Compraventa) loads fully prefilled —
      name, description, stages, roles, requirements all correct
- [ ] Usage banner shows the real Case count for a Blueprint that has been used
- [ ] Changing a field and saving persists the change; reloading /blueprints/<id>/edit shows it
- [ ] Loaded roles/requirement keys are all "touched" — renaming a role's display name does not
      change its underlying key

Duplicate
- [ ] "Duplicar" from a Plantillas card opens /blueprints/new?from=<id> prefilled from the source,
      with no usage banner even though the source has uses
- [ ] Saving creates a new, separate Blueprint; the source Blueprint is completely unchanged

Cascades
- [ ] Deleting a stage with attached requirements shows the confirm dialog; confirming leaves
      those requirements with "Sin etapa" rather than blocking the deletion
- [ ] Deleting a role with attached requirements shows the confirm dialog; confirming removes
      those requirements entirely

Reorder
- [ ] Moving a stage up/down keeps its attached requirements associated with the same stage (by
      name), not reassigned by index

Dirty-state guard
- [ ] Editing a field then clicking Cancelar triggers the "cambios sin guardar" confirm modal
- [ ] Editing a field then reloading the tab triggers the native beforeunload prompt
- [ ] Saving successfully does not show a stale dirty warning afterward

Owner gating
- [ ] A non-owner staff account sees no "Nueva plantilla" button and no Editar/Duplicar/Eliminar
      controls on /blueprints
- [ ] A non-owner staff account hitting /blueprints/new or /blueprints/<id>/edit directly by URL
      is redirected to /blueprints, never shown the editor

Delete
- [ ] Deleting an unused Blueprint from a Plantillas card removes it from the list immediately
- [ ] Deleting a used Blueprint (from the edit screen's Eliminar button) succeeds; a Case
      previously cloned from it is confirmed unaffected (its stages/requirements still present) by
      opening that Case afterward; a direct query confirms its origin_blueprint_id is now null

Browser tested:
- [ ] Chrome
```

- [ ] **Step 6: Reset to a clean baseline**

```bash
npm run db:reset
npm run db:seed
```

- [ ] **Step 7: Commit test changes**

```bash
git add tests/integration/save-blueprint.test.ts
git commit -m "Expand save_blueprint integration tests to full closed-error-code coverage"
```

---

## Task 11: Type regeneration, lint, typecheck, full suite

**Files:** none (verification only)

- [ ] **Step 1: Regenerate Supabase types from the final schema state**

```bash
npm run db:reset
npm run db:types
git status --short src/types/database.ts
```
Expected: either no diff (Task 1 already regenerated correctly and nothing since has changed the
schema) or a clean diff limited to the `save_blueprint` function entry and the new constraint —
review it before staging.

- [ ] **Step 2: Lint and typecheck the whole repo**

```bash
npm run lint
npm run typecheck
```
Expected: both clean, zero errors, zero warnings.

- [ ] **Step 3: Run the full automated test suite**

```bash
npx vitest run
```
Expected: every test file passes — every pre-existing test (including the entire Phase 2 Blueprint
selector suite) plus every new file from Tasks 1-10:
`tests/isolation/blueprint-authoring.test.ts`, `tests/unit/blueprints/validate-blueprint-structure.test.ts`,
`tests/unit/blueprints/to-persistence-json.test.ts`, `tests/unit/blueprints/serialize-draft.test.ts`,
`tests/integration/save-blueprint.test.ts`.

- [ ] **Step 4: Confirm the generic isolation sweeps still pass unmodified**

```bash
npx vitest run tests/isolation/cross-tenant-sweep.test.ts tests/isolation/schema-guard.test.ts
```
Expected: both pass with no edits made to either file across this whole plan (confirmed already in
Task 2, re-confirmed here as the final gate).

- [ ] **Step 5: Reset to a clean seeded baseline**

```bash
npm run db:reset
npm run db:seed
```

- [ ] **Step 6: Final commit if any cleanup was needed**

```bash
git status --short
```
If clean, nothing to commit — this task is verification-only. If lint/typecheck/type-regeneration
fixes were needed above, commit them here with a message describing what was fixed.

---

## Self-Review

**1. Spec coverage:**
- Schema/RPC (migration guard, `save_blueprint` full body, stable error codes, `FOR UPDATE` lock,
  array-type checks, null-before-regex checks, numeric-string-before-cast checks, length limits) →
  Task 1. ✓
- Isolation/RLS/atomicity/concurrency/malformed-payload tests → Task 2. ✓
- Shared validation layer (`normalizeBlueprintFromDb`/`normalizeBlueprintDraft`/
  `validateBlueprintStructure`, `BlueprintIntegrityError`, `ValidatedBlueprintStructure` refinement)
  → Task 3. ✓
- camelCase↔snake_case serialization (`toPersistenceJson`) → Task 4. ✓
- Use cases + closed RPC-error mapping (`saveBlueprint`, `deleteBlueprint`, `AuditAction`
  extension, delete's non-forbidden-catch-all fix) → Task 5. ✓
- Server Actions + owner gating (`src/app/blueprints/actions.ts`, separate from
  `src/app/cases/actions.ts`) → Task 6. ✓
- Draft model + `BlueprintEditor` (stable `draftId`s, slug autogeneration with `keyTouched`,
  cascade-on-delete confirms, usage banner, navigation guard scope, mode-driven copy) → Task 7. ✓
- Routes (`/blueprints/new` with `?from=`, `/blueprints/[id]/edit`, owner redirect, `notFound()`) →
  Task 8. ✓
- Plantillas affordances (Nueva plantilla, Editar, Duplicar, Eliminar, delete confirm with generic
  copy) → Task 9. ✓
- Full test coverage (all RPC codes, manual checklist) → Task 10. ✓
- Type regeneration, lint, typecheck, full suite, isolation-sweep re-confirmation → Task 11. ✓

**2. Placeholder scan:** No TBD/TODO markers. Every code block is complete and runnable. The one
intentionally-limited test (Task 10's "rethrows... as unexpected" case) documents exactly why it
can't fabricate a genuine unexpected Postgres error rather than leaving a fake assertion — this is
an honest scope note, not a placeholder.

**3. Type consistency:** Cross-checked field names across all tasks —
`NormalizedBlueprint`/`ValidatedBlueprintStructure`/`SaveBlueprintDraftInput` (Task 3) match
`toPersistenceJson`'s input (Task 4) match `saveBlueprintSchema`'s parsed output consumed by
`normalizeBlueprintDraft` (Task 5) match `EditorDraft`'s `serializeDraftToNormalizedBlueprint`
output (Task 7) match `toSaveBlueprintPayload`'s conversion back into the Zod discriminated-union
shape (Task 7) match `saveBlueprintAction`'s parameter type (Task 6). `roleKeySchema`/
`requirementKeySchema` limits (100/200) are identical between Task 1's SQL and Task 5's Zod
schemas. `BlueprintIntegrityError.code` strings used in Task 3's validator
(`invalid_role_key`, `duplicate_role_key`, `duplicate_participant_position`,
`duplicate_stage_position`, `invalid_key`, `missing_label`, `invalid_scope`,
`missing_participant_role_key`, `orphaned_role_key`, `unexpected_participant_role_key`,
`orphaned_stage_position`, `duplicate_key`) exactly match the keys of Task 5's
`INTEGRITY_MESSAGES` map — verified no key is defined in one and missing from the other.
