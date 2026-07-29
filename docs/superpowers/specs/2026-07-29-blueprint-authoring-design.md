# Blueprint Authoring Flow — Design

## Context

The prior spec (`2026-07-29-blueprint-selector-design.md`) connected the Create Case wizard's
Blueprint picker and the Plantillas page to a real backend — `blueprints`, `blueprint_stages`,
`blueprint_participant_templates`, and a strict/tolerant query-layer split
(`getBlueprintDefinition`/`listBlueprintSummaries`) — but that pass was explicitly read-only. There
is no way for an organization owner to create, edit, duplicate, or delete a Blueprint; all four
Blueprints in the system exist only via `scripts/seed-demo.mjs`.

This spec builds the authoring flow on top of that foundation: `/blueprints/new` (create from
scratch, or duplicate an existing org Blueprint into a new one), `/blueprints/[id]/edit`, and
delete — reusing the existing schema, the existing strict validation rules, and the existing card
UI, while introducing exactly one new domain concept: a transactional `save_blueprint` RPC and the
shared validator/normalizer split it and the read path both consume.

**Explicitly out of scope, deferred to future specs:**
- A global/cross-org Blueprint catalog. "Use existing Blueprint" only ever shows same-organization
  Blueprints; `is_platform_template` remains metadata only, with no visibility effect, exactly as the
  prior spec left it.
- Sync with any future AVANZA-wide template updates.
- Advanced versioning (revision history, rollback, change tracking).
- Retroactive updates to Cases already cloned from a Blueprint — editing or deleting a Blueprint
  never touches a Case that was created from it (`origin_blueprint_id` already has
  `on delete set null`; no new schema is needed to make hard delete safe).
- Archiving. This pass uses hard delete only — see Decision D1 below.
- Automated component/UI tests. Same reasoning as the prior spec: this codebase has no
  component-testing infrastructure. UI behavior is covered by a manual verification checklist.

## Key decisions

- **D1 — Hard delete, no archive.** Consistent with the current domain's simplicity; archiving is a
  real dimension (who can un-archive, does an archived Blueprint still show in "duplicate from"
  pickers, etc.) that has no present need. Revisit if versioning or a marketplace is ever built.
- **D2 — `save_blueprint` is one atomic RPC**, not a multi-step client orchestration. Unlike
  `createCaseWithParticipants` (which orchestrates external side effects — invitations — and is
  deliberately non-atomic), a Blueprint save has no external side effects, so atomicity is cheap and
  removes a whole category of partial-write bugs.
- **D3 — Stages are optional and skippable** at every step of authoring, not just at read time. A
  Blueprint with zero stages is valid; nothing forces a placeholder "General" stage.
- **D4 — Editing an already-used Blueprint is fully open**, no confirmation gate — only a persistent,
  informational usage banner. Existing Cases are structurally immune (they were deep-copied, not
  linked), so there is nothing to protect the user from.
- **D5 — One `BlueprintEditor` component, three modes** (`'create' | 'edit' | 'duplicate'`), not
  separate wizards. All three share the same steps, validation, and state machine; only copy, the
  presence of a delete button, and the usage banner vary by mode.
- **D6 — Three-layer validation**, replacing a single shared-function proposal:
  `normalizeBlueprintFromDb` (read-side, defaults missing `scope` to `'case'` for legacy
  compatibility) and `normalizeBlueprintDraft` (write-side, requires `scope` explicitly — new
  authoring must never produce legacy-shaped data) both feed the same
  `validateBlueprintStructure`, which owns every domain invariant and returns the canonical
  `BlueprintDefinition` shape, not booleans or an error list. This keeps read-compatibility leniency
  from silently leaking into the write path.
- **D7 — Defense in depth on the RPC.** The TypeScript validator is not the only gate:
  `save_blueprint` independently re-validates the critical relational invariants (ownership, unique
  stage/participant positions, unique role keys, valid role/stage references, per-bucket key
  uniqueness) so a direct RPC call, a stale client, or a future alternate write path cannot bypass
  domain integrity — with real `unique()` constraints as the final, unbypassable backstop underneath
  the RPC's own friendlier preflight checks.

## Architecture overview

```
Schema/RPC (atomic save_blueprint + delete)
  → Shared validation (normalizeBlueprintFromDb / normalizeBlueprintDraft / validateBlueprintStructure)
    → Use cases (saveBlueprint, deleteBlueprint)
      → Server Actions (src/app/blueprints/actions.ts)
        → BlueprintEditor (single component, mode: 'create' | 'edit' | 'duplicate')
          → Plantillas page gains Nueva plantilla / Editar / Duplicar / Eliminar
```

## 1. Schema

**Migration** `supabase/migrations/20260729130000_blueprint_authoring.sql`:
```sql
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

-- Participant-template position becomes load-bearing once a real write path exists (previously
-- app-layer-only, per the prior spec's design note). Mirrors blueprint_stages' own constraint.
alter table public.blueprint_participant_templates
  add constraint blueprint_participant_templates_blueprint_id_position_key unique (blueprint_id, position);
```

No other schema changes. `blueprints`, `blueprint_stages`, `blueprint_participant_templates`,
`requirement_definitions`'s JSON shape, and `create_case`'s scope filter are all reused unchanged.

## 2. `save_blueprint` RPC

`security invoker`, matching `create_case`'s existing convention exactly (not a new one) — every
write still passes through the existing owner-only RLS policies regardless of what the function
attempts, and `set search_path = ''` with fully schema-qualified references (`public.blueprints`,
`app.is_org_owner`) is defense-in-depth on top of that.

```sql
create or replace function public.save_blueprint(
  target_organization_id uuid,
  target_blueprint_id uuid,        -- null = create; present = edit (full child replace)
  blueprint_name text,
  blueprint_description text,
  stages jsonb,                    -- [{name, position}], snake_case, never null (empty array if none)
  participant_templates jsonb,     -- [{role_key, display_name, position}]
  requirement_definitions jsonb    -- [{key, type, label, instructions, scope, participant_role_key, stage_position}]
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
  -- 1. Ownership, explicit — RLS re-enforces this on every write below regardless, but this gives
  --    one clean error instead of a confusing partial-delete-then-insert-denied failure.
  if not app.is_org_owner(target_organization_id) then
    raise exception using errcode = 'P0001', message = 'not_owner';
  end if;

  -- 2. Payload shape: jsonb_array_elements() throws an uncontrolled error on anything that isn't
  --    a JSON array (object, string, number, boolean), so this must be checked before any of the
  --    array-iterating validation below runs, not just SQL NULL via coalesce above.
  if jsonb_typeof(stages_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_stages_payload';
  end if;
  if jsonb_typeof(templates_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_participant_templates_payload';
  end if;
  if jsonb_typeof(requirements_in) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_requirements_payload';
  end if;

  -- 3. Edit-mode existence check, row-locked. FOR UPDATE serializes concurrent full-replace edits
  --    to the same Blueprint for the rest of this transaction — without it, two concurrent calls
  --    could interleave their child deletes/inserts and produce constraint failures or confusing
  --    last-writer outcomes. Under security invoker, this select still passes through blueprints'
  --    member-read RLS policy — a cross-org id or a genuinely missing one both land here as "not
  --    found," which is the point: this must not distinguish the two.
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

  -- 4. Basic parent-field shape checks.
  if blueprint_name is null or length(btrim(blueprint_name)) = 0 or length(btrim(blueprint_name)) > 200 then
    raise exception using errcode = 'P0001', message = 'invalid_blueprint_name';
  end if;
  if blueprint_description is not null and length(btrim(blueprint_description)) > 2000 then
    raise exception using errcode = 'P0001', message = 'invalid_blueprint_description';
  end if;

  -- 5. Stage shape + duplicate position. Every required field gets an explicit `is null` branch
  --    first: PostgreSQL's three-valued logic means `elem->>'name' is null` is NOT the same as
  --    the regex/length checks failing — a missing key makes `->>'x' !~ '...'` evaluate to NULL,
  --    not TRUE, so the row would silently pass the `where` filter and never rejects. Numeric
  --    fields are validated as digit strings BEFORE any `::int` cast — an unchecked cast on a
  --    direct caller's malformed input (e.g. `"position": "abc"`) would otherwise raise an
  --    uncontrolled PostgreSQL error instead of a clean, mapped validation error.
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

  -- 6. Participant-template shape + duplicate role_key / position.
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

  -- 7. Requirement shape, scope validity, and orphan references. `participant_role_key` absent
  --    and `participant_role_key: null` both read as SQL NULL through `->>` — treated identically
  --    here, on purpose (see the prose note below the function on this canonicalization choice).
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

  -- Safe to cast now: the shape check above already rejected any non-digit-string stage_position.
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

  -- 8. Write. Create: insert parent, then children. Edit: replace children, then update parent
  --    last — the parent write is the definitive "this Blueprint's new shape" commit point,
  --    though the whole function is one transaction regardless of internal order.
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
    update public.blueprints
    set name = btrim(blueprint_name),
        description = nullif(btrim(coalesce(blueprint_description, '')), ''),
        requirement_definitions = requirements_in,
        updated_at = now()
    where id = target_blueprint_id and organization_id = target_organization_id;

    -- Defensive only: the FOR UPDATE lock above already guarantees this row exists and is ours
    -- for the rest of the transaction. Kept explicit so the function's contract doesn't silently
    -- depend on that lock remaining in place if this function is ever refactored.
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

**Empty arrays** are valid throughout — `stages_in`/`templates_in`/`requirements_in` default to
`'[]'::jsonb`, and every validation/insert query over an empty array is simply a no-op.

**Missing key vs. explicit JSON `null`**: `->>'field'` produces SQL `NULL` for both an absent key
and an explicit `"field": null`, and every check in this function relies on that equivalence — a
`case`-scoped requirement with `"participant_role_key": null` is treated identically to one that
omits the field entirely. This is intentional, not an accidental consequence of the `->>` operator:
`toPersistenceJson` (the use-case-layer serializer, section 4) never emits an optional key with an
explicit `null` value — it omits the key outright — so in practice only the read path could ever
receive one, and it already treats both the same way today (`getBlueprintDefinition`'s existing
`participantRoleKeyRaw !== undefined && participantRoleKeyRaw !== null` check, unchanged by this
spec). Canonicalizing the two here keeps the RPC consistent with that pre-existing read behavior
rather than introducing a second standard.

**Deletion** uses no RPC. `deleteBlueprint` is a plain
`delete from blueprints where id = ? and organization_id = ?`, relying on the existing owner-only
RLS policy plus the already-existing `on delete cascade` (child tables) and
`on delete set null` (`cases.origin_blueprint_id`) — both confirmed already in place, no new FK
behavior needed.

**camelCase ↔ snake_case**: the RPC and stored JSON only ever use snake_case
(`role_key`, `display_name`, `participant_role_key`, `stage_position`; `key`/`type`/`label`/
`instructions`/`scope`/`position`/`name` are already identical in both). The one translation point
is a `toPersistenceJson` mapper inside the `saveBlueprint` use case, applied to
`validateBlueprintStructure`'s camelCase return value immediately before the `.rpc()` call. The SQL
layer never has camelCase awareness — this matches how `create_case` already reads this same jsonb
shape today.

## 3. Shared validation layer

Refactors `src/features/blueprints/queries.ts`'s internals — `getBlueprintDefinition`'s public
signature and behavior are unchanged, only its internal ~15-rule integrity checklist moves out into
a shared, reusable shape:

```ts
interface NormalizedBlueprint {
  name: string;
  description: string | null;
  stages: { name: string; position: number }[];
  participantTemplates: { roleKey: string; displayName: string; position: number }[];
  requirements: {
    key: string; type: string; label: string; instructions: string | null;
    scope: 'case' | 'participant'; participantRoleKey: string | null; stagePosition: number | null;
  }[];
}

class BlueprintIntegrityError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function normalizeBlueprintFromDb(row: RawBlueprintDefinitionRow): NormalizedBlueprint;
// Read-side: missing `scope` defaults to 'case' (legacy compatibility).

function normalizeBlueprintDraft(input: SaveBlueprintDraftInput): NormalizedBlueprint;
// Write-side: `scope` is required and never defaulted — new authoring must never produce
// legacy-shaped data.

function validateBlueprintStructure(input: NormalizedBlueprint): BlueprintDefinition;
// Shared, pure, domain-owning. Throws BlueprintIntegrityError — never UseCaseError, since this
// function is also called from the read path and potentially future callers that know nothing
// about the application layer. Enforces: slug validation; participant role uniqueness; stage
// position uniqueness; scope ↔ participant-role coupling; orphaned role references; stage-position
// references; per-bucket requirement-key uniqueness; deterministic ordering by position.
```

`getBlueprintDefinition` becomes `validateBlueprintStructure(normalizeBlueprintFromDb(row))`, and
lets `BlueprintIntegrityError` propagate uncaught — exactly its current behavior (an internal
integrity failure on read is already unexpected, not a `UseCaseError`).

The write path is `validateBlueprintStructure(normalizeBlueprintDraft(wizardInput))`. Its return
value — the canonical `BlueprintDefinition` shape — is what `toPersistenceJson` serializes for the
RPC call, so there is exactly one place that builds the persisted shape, never two independently
maintained ones.

## 4. Use cases and Server Actions

`src/application/save-blueprint.ts`:

```ts
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

const requirementSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('case'),
    key: requirementKeySchema,
    type: requirementTypeSchema,
    label: z.string().trim().min(1).max(300),
    instructions: z.string().trim().max(2000).optional(),
    stagePosition: z.number().int().min(0).optional(),
  }).strict(),
  z.object({
    scope: z.literal('participant'),
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
```

`saveBlueprint(client, input, actorAuthUserId)`:
1. Parse with `saveBlueprintSchema` → `ValidationError` → `UseCaseError('validation', ...)`.
2. `validateBlueprintStructure(normalizeBlueprintDraft(parsed))` — catch `BlueprintIntegrityError`
   and translate by `.code` into `UseCaseError('validation', friendlyMessage(code))`; anything else
   rethrows.
3. Call `client.rpc('save_blueprint', { ...toPersistenceJson(validated) })`.
4. Map the RPC's error `.message` (its stable code) through a **closed** table:
   ```ts
   const RPC_VALIDATION_MESSAGES: Record<string, string> = {
     invalid_stages_payload: 'El formato de las etapas no es válido.',
     invalid_participant_templates_payload: 'El formato de los roles de participante no es válido.',
     invalid_requirements_payload: 'El formato de los requisitos no es válido.',
     invalid_blueprint_name: 'El nombre de la plantilla no es válido.',
     invalid_blueprint_description: 'La descripción es demasiado larga.',
     invalid_stage_shape: 'Una etapa tiene datos inválidos.',
     duplicate_stage_position: 'No puede haber dos etapas con la misma posición.',
     invalid_participant_template_shape: 'Un rol de participante tiene datos inválidos.',
     duplicate_participant_role_key: 'Cada rol de participante debe tener un identificador único.',
     duplicate_participant_position: 'No puede haber dos roles de participante con la misma posición.',
     invalid_requirement_shape: 'Un requisito tiene datos inválidos.',
     unknown_participant_role_key: 'Un requisito hace referencia a un rol de participante inexistente.',
     unknown_stage_position: 'Un requisito hace referencia a una etapa inexistente.',
     duplicate_requirement_key: 'Cada requisito debe tener una clave única dentro de su alcance.',
   };
   ```
   - Message is a key in `RPC_VALIDATION_MESSAGES` → `UseCaseError('validation', message)`.
   - Message is `'blueprint_not_found'` → `UseCaseError('not_found', 'La plantilla ya no existe.')`.
   - Message is `'not_owner'` → `UseCaseError('forbidden', 'Solo el propietario puede editar esta plantilla.')`.
   - Anything else → rethrow unchanged (`unexpected`) — never silently downgraded to `forbidden`.
5. `logDomainEvent(..., action: blueprintId ? 'blueprint.updated' : 'blueprint.created', ...)`.
   A failure here is not separately caught — matches `createCaseWithParticipants`'s existing
   convention of an unguarded `await logDomainEvent(...)`, not a new fire-and-forget pattern
   introduced only for Blueprints.
6. Return `{ blueprintId: new_blueprint_id }`.

`deleteBlueprint(client, { organizationId, blueprintId }, actorAuthUserId)`:
```ts
const { data, error } = await client
  .from('blueprints')
  .delete()
  .eq('id', blueprintId)
  .eq('organization_id', organizationId)
  .select('id')
  .maybeSingle();

if (error) {
  // Only a recognized permission-denied error maps to 'forbidden' — a network failure, malformed
  // query, or unexpected trigger error is not an authorization failure and must not be disguised
  // as one (matches the same closed-mapping principle used for the save path's RPC errors).
  if (error.code === '42501') {
    throw new UseCaseError('forbidden', 'No tienes permiso para eliminar esta plantilla.');
  }
  throw error;
}
if (!data) throw new UseCaseError('not_found', 'La plantilla no existe o ya fue eliminada.');

await logDomainEvent(client, { ..., action: 'blueprint.deleted', ... });
return { blueprintId: data.id };
```

**`src/app/blueprints/actions.ts`** (new file — kept separate from `src/app/cases/actions.ts` so
Plantillas never depends on the Expedientes module):
```ts
export async function saveBlueprintAction(
  input: Omit<SaveBlueprintInput, 'organizationId'>,
): Promise<ActionResult<{ blueprintId: string }>> {
  const staff = await getStaffContext();
  if (!staff) return { ok: false, reason: 'unauthenticated', message: 'Tu sesión expiró. Inicia sesión de nuevo.' };
  if (staff.role !== 'owner') {
    return { ok: false, reason: 'forbidden', message: 'Solo el propietario puede crear o editar plantillas.' };
  }
  const client = await createClient();
  try {
    return ok(await saveBlueprint(client, { ...input, organizationId: staff.organizationId }, staff.userId));
  } catch (error) {
    return fail(error);
  }
}

export async function deleteBlueprintAction(blueprintId: string): Promise<ActionResult<{ blueprintId: string }>> {
  // same shape: getStaffContext → owner check → delegate → ok/fail
}

export async function getBlueprintDefinitionAction(blueprintId: string): Promise<ActionResult<BlueprintDefinition>> {
  // thin wrapper around the existing getBlueprintDefinition query, for client-component call sites
}
```
The owner check mirrors `src/app/settings/actions.ts`'s `updateOrganizationAction` exactly — a
fast, user-facing rejection here. The independent re-check below the Server Action differs by
operation, and the prose should say so precisely rather than imply symmetry:
- `saveBlueprint`: an **explicit** `app.is_org_owner` check inside the RPC itself (section 2, step
  1), plus owner-only RLS on every table it writes to.
- `deleteBlueprint`: **no explicit ownership query** — it relies solely on the existing
  `blueprints_write_by_owner`-style RLS policy to make the `delete` affect zero rows for a
  non-owner, which surfaces as the same `not_found` a caller would see for a nonexistent id. This
  is an intentional asymmetry, not an oversight: adding an explicit ownership round-trip to
  `deleteBlueprint` would be a second query for a check RLS already performs for free on a
  single-statement delete, and no other single-statement delete in this codebase does that either.

Final layering:
```
Server Action   → authenticated identity + organization, owner check
Use case        → Zod + shared structural validator (BlueprintIntegrityError → UseCaseError)
RPC             → defensive validation + atomic write, independent ownership + invariant checks
Constraints/RLS → final integrity + authorization backstop
```

## 5. UI

### Routes and modes
- `/blueprints/new` → Server Component, `requireStaff()` then redirect to `/blueprints` if not
  owner. No `blueprintId`; if a `?from=<id>` query param is present, loads that Blueprint via
  `getBlueprintDefinition(client, id, organizationId)` directly (not the Server Action — a Server
  Component with its own client and context has no reason to go through `ok`/`fail`), renders
  `<BlueprintEditor mode="duplicate" initialBlueprint={definition} usageCount={0} />`; if `from` is
  missing/inaccessible, `notFound()`. Otherwise renders
  `<BlueprintEditor mode="create" initialBlueprint={null} usageCount={0} />`.
- `/blueprints/[id]/edit` → same owner gate; loads the definition and a usage count (below) via
  direct query calls; a missing definition is `notFound()`; renders
  `<BlueprintEditor mode="edit" blueprintId={id} initialBlueprint={definition} usageCount={n} />`.

### Usage count
Kept out of `BlueprintDefinition` entirely — a separate query, `countCasesUsingBlueprint`, called
only by the edit route:
```ts
const { count, error } = await client
  .from('cases')
  .select('*', { count: 'exact', head: true })
  .eq('origin_blueprint_id', blueprintId)
  .eq('organization_id', organizationId);
```
An `error` here propagates (no silent `0` fallback — an unknown failure must never be presented as
"unused"). The delete-confirmation modal triggered from a Plantillas card (not the edit screen)
doesn't have a count preloaded, so its copy stays generic: *"Los expedientes creados previamente no
se verán afectados."* — no number, to avoid an extra round-trip just for modal copy. The edit
screen's persistent banner does show the specific count, since the page already loaded it.

### `BlueprintEditor`
One client component, `src/app/blueprints/blueprint-editor.tsx`:
```ts
{ mode: 'create' | 'edit' | 'duplicate'; blueprintId?: string; initialBlueprint: BlueprintDefinition | null; usageCount: number }
```
Internal state is one `draft` object plus `step` (0-4) and `isDirty`. `initialBlueprint` seeds
`draft` for `edit`/`duplicate`; `create` starts blank.

**Draft shape uses stable local IDs, not position, as in-editor identity** — reordering must never
silently reassign a requirement to a different stage or role:
```ts
type DraftStage = { draftId: string; name: string };
type DraftParticipantTemplate = { draftId: string; roleKey: string; keyTouched: boolean; displayName: string };
type DraftRequirement = {
  stageDraftId: string | null;
  participantRoleDraftId: string | null; // only when scope === 'participant'
  key: string; keyTouched: boolean; type: string; label: string; instructions?: string;
  scope: 'case' | 'participant';
};
```
`position`, `stagePosition`, and `participantRoleKey` are derived only at submit time, by
`serializeDraftToNormalizedBlueprint(draft)`. Loading an existing Blueprint (`edit`/`duplicate`)
initializes every `keyTouched` as `true` — renaming a role's display name must never silently
change its `roleKey`.

**Slug autogeneration**: while `keyTouched` is `false`, editing `displayName`/`label` regenerates
the slug (strip diacritics → lowercase → non-alphanumerics to `-` → collapse repeats → trim
leading/trailing `-`); the first manual edit to the key field sets `keyTouched = true` and it never
auto-updates again. This transformation is UI-only — the shared validator never transforms input,
only rejects it.

### Five steps
1. **Información** — name, description. Field-level validation gates "Siguiente."
2. **Etapas** — add/remove/reorder via up/down buttons (not drag-and-drop, for MVP — the
   `draftId` model supports adding drag later without touching serialization logic). Optional and
   skippable; an empty list is valid, never blocks "Siguiente."
3. **Participantes** — `displayName`, auto-slugged `roleKey`, reorder via up/down. Also optional.
4. **Requisitos** — label, auto-slugged `key`, `type`, `scope` (participant scope only offered if
   Step 3 has at least one role), `stagePosition` (dropdown of Step 2's stages, optional), 
   `instructions`.
5. **Revisión** — read-only summary (counts + compact list, matching the Plantillas card style)
   plus the save action.

**Validation granularity**: per-step field validation (required, slug format, immediate duplicate
detection) controls "Siguiente" for Steps 1-3. The full
`validateBlueprintStructure(serializeDraftToNormalizedBlueprint(draft))` pass runs when leaving
Requisitos, when entering Revisión, and at final submit — not on every step, since a fully valid
in-progress draft (e.g. no requirements yet on Step 2) would otherwise be incorrectly rejected by a
validator that expects a complete structure.

### Deleting a referenced stage or role (inside the editor)
- Stage with attached requirements: confirm modal — *"N requisitos usan esta etapa. Si la eliminas,
  quedarán sin etapa."* → on confirm, those requirements' `stageDraftId` → `null` (never blocks
  deletion).
- Role with attached requirements: confirm modal — *"Este rol tiene N requisitos asociados. Al
  eliminarlo también se eliminarán esos requisitos."* → on confirm, cascades to remove those
  requirement drafts entirely (converting them to `case` scope would be an unrequested semantic
  change, so it is not offered).

### Usage banner
Shown only when `mode === 'edit' && usageCount > 0`, persistent across every step (not just
Revisión), never a confirmation gate: *"Esta plantilla ya se usó en {usageCount} expediente(s). Los
cambios no afectan expedientes existentes."*

### Navigation guard — explicit scope
Covered by an internal confirm modal: the editor's own Cancelar/Volver controls and links rendered
inside the editor's tree. Covered by `beforeunload`: tab close, reload, typed URL. **Not covered**:
global sidebar links or navigation outside the editor's component tree — no new cross-app guard
infrastructure is introduced. Condition is exactly `isDirty && !isSaving`; `isDirty` is cleared
*before* the post-save redirect, so no false warning fires.

### Delete (from the edit screen or a Plantillas card)
Confirmation modal stating the deletion is permanent; if `usageCount > 0` (edit screen only, since
that's the only place it's preloaded), adds *"Los expedientes ya creados no se verán afectados."*
On confirm, calls `deleteBlueprintAction`, then redirects to `/blueprints`.

### Loading / error / save states
`isSaving` disables the final CTA and shows a spinner; `saveError` renders inline above the CTA
using the existing error-banner styling. No separate success toast — a successful save redirects
immediately.

### Post-save navigation
One convention for all three modes: **always redirect to `/blueprints`** after a successful save —
simpler than two conventions, and re-opening for another edit is one click from the directory card.

### Mode-driven visual differences
A single `MODE_COPY` record keyed by `mode`, not scattered conditionals:

| | create | duplicate | edit |
|---|---|---|---|
| Title | "Nueva plantilla" | "Nueva plantilla (copia de {source.name})" | "Editar {draft.name}" |
| Final CTA | "Crear plantilla" | "Crear plantilla" | "Guardar cambios" |
| Usage banner | never | never | if `usageCount > 0` |
| Delete button | never | never | always present |

### Submission contract
`BlueprintEditor` always sends the **complete current draft** (name, description, all stages, all
participant templates, all requirements) to `saveBlueprintAction`, never a partial diff — matching
`save_blueprint`'s full-replace semantics. `blueprintId` is included only in `edit` mode.

### Owner gating
Mirrors `settings/actions.ts`'s existing `staff.role !== 'owner'` pattern exactly — no new
`requireOwner()` route-guard function, since `StaffContext` already carries `role`.
- `/blueprints/new` and `/blueprints/[id]/edit`: `requireStaff()` then redirect to `/blueprints` if
  not owner.
- `saveBlueprintAction`/`deleteBlueprintAction`: same check before delegating.
- `/blueprints` itself stays visible to any staff member; only "Nueva plantilla" / "Editar" /
  "Duplicar" / "Eliminar" are conditionally rendered based on `staff.role === 'owner'`.

## 6. Testing

**Pure validator/normalizers** (`tests/unit/blueprints/*.test.ts`, no DB):
- `normalizeBlueprintFromDb`: missing `scope` defaults to `'case'`.
- `normalizeBlueprintDraft`: missing `scope` is rejected, never defaulted.
- `validateBlueprintStructure`: one passing case and one failing case per rule (invalid slug,
  duplicate role key, duplicate stage position, duplicate participant-template position, orphaned
  `participantRoleKey`, orphaned `stagePosition`, duplicate key within a bucket, cross-bucket key
  reuse *allowed*, scope/role coupling both directions, deterministic ordering regardless of input
  array order).
- `serializeDraftToNormalizedBlueprint`: reordering stages preserves `stageDraftId` associations; a
  `stageDraftId: null` requirement serializes with no `stagePosition`; role-deletion cascade and
  stage-orphan-to-null are exercised as draft-shape fixtures.

**Use case + RPC error mapping** (`tests/integration/save-blueprint.test.ts`, real local Postgres —
matching the existing `blueprint-queries.test.ts` convention, not mocks):
- Create succeeds, returns id, all children persisted correctly.
- Edit fully replaces children (an old stage/role absent from the new payload is gone after save).
- Each RPC error code maps to the correct `UseCaseError` reason + Spanish message.
- An unrecognized error code rethrows as unexpected — never silently becomes `forbidden`.
- Edit against a cross-org `blueprintId` → `not_found`, indistinguishable from a nonexistent id.
- `deleteBlueprint`: successful delete, delete of an already-gone id → `not_found`, audit logged
  only on an actual deletion.

**DB integration — atomicity, RLS, constraints** (`tests/isolation/blueprint-authoring.test.ts`):
- A non-owner staff member's direct RPC call fails at the explicit `not_owner` check.
- A payload failing preflight validation leaves the Blueprint's existing rows completely
  unchanged (proves rollback, not a partial stop).
- A raw insert into `blueprint_participant_templates` with a duplicate `(blueprint_id, position)`
  is rejected by the new unique constraint, independent of the RPC.
- `cross-tenant-sweep.test.ts` / `schema-guard.test.ts`: re-read both files at implementation time
  to confirm no new table or composite FK was introduced (this migration only adds a constraint).
- **Malformed direct-call payloads** (each exercising a specific defensive check added in this
  round of review, not just the happy path): `stages: {}` (object instead of array) →
  `invalid_stages_payload`; a participant template missing `role_key` entirely →
  `invalid_participant_template_shape` (proves the explicit `is null` branch actually catches an
  absent field, not just a malformed one); a requirement missing `scope` →
  `invalid_requirement_shape`; a requirement with `stage_position: "abc"` → `invalid_requirement_shape`
  (proves the numeric-string check runs, and runs, before any `::int` cast is attempted); a stage
  `name` of 201 characters, a `role_key` of 101 characters, a requirement `label` of 301
  characters, `type` of 101 characters, and `instructions` of 2001 characters → each its
  corresponding `invalid_*_shape` code; a requirement with `participant_role_key: null` under
  `scope: 'case'` → accepted (proves explicit JSON `null` and an absent key are treated
  identically, per the documented canonicalization).
- **Concurrent edits**: two overlapping `save_blueprint` calls targeting the same
  `blueprintId`, launched without waiting for the first to commit — confirms the second call
  blocks on the `FOR UPDATE` lock until the first transaction finishes rather than interleaving
  deletes/inserts, and that the final state is exactly one call's full payload, never a mix of
  both.

**UI behavior** — manual verification checklist (no component-testing infrastructure, same
convention as the prior spec):
- Create: all 5 steps, including skipping Etapas/Participantes → save → lands on `/blueprints` →
  new card with correct counts.
- Edit: open a seeded Blueprint → fields prefilled → usage banner shows the real count → change a
  field → save → redirected → change persisted.
- Duplicate: "Duplicar" → editor opens prefilled, no `blueprintId`, no usage banner despite the
  source having uses → save → a new, separate Blueprint appears; source untouched.
- Cascades: delete a stage with requirements → confirm → requirements show "Sin etapa"; delete a
  role with requirements → confirm → those requirements are gone.
- Reorder: moving a stage via up/down keeps its requirements attached to the same stage.
- Dirty-state guard: internal Cancelar triggers the modal; a reload while dirty triggers
  `beforeunload`; a successful save shows no stale warning afterward.
- Owner gating: a non-owner sees no authoring controls on `/blueprints`; a direct hit to
  `/blueprints/new` or `/blueprints/<id>/edit` as non-owner redirects to `/blueprints`.
- Delete: confirm + hard delete a used Blueprint → card disappears → a Case previously cloned from
  it is unaffected, with `origin_blueprint_id` now null.
