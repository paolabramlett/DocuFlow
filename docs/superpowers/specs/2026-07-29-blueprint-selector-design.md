# Blueprint Selector → Real Backend — Design

## Context

The Create Case wizard's Blueprint picker (`src/app/cases/new/page.tsx`, Step "Plantilla") and the
Plantillas page (`src/app/blueprints/page.tsx`) are both entirely synthetic — hardcoded demo data,
explicitly labeled as such in both files' header comments. Meanwhile the real backend is mostly
already built and unused: the `blueprints` table, `blueprint_stages`, the `create_case` RPC that
deep-clones a Blueprint's stages and requirement definitions into a new Case, and the full
`blueprintId` plumbing through `createCaseWithParticipants` → `createCase` → the RPC. The only
broken link is the UI: the wizard picks from a fake list and then explicitly never sends the chosen
`blueprintId` to the server.

This spec connects the selector to the real backend end to end. In the process it closes a real gap
in the domain model: the wizard's demo data assumes each Blueprint suggests **participant roles**
(e.g. "Comprador", "Vendedor"), but the real `blueprints` table has no such concept — only a name,
description, and a flat, inert JSON array of requirement definitions. This spec introduces
**Blueprint Participant Templates** as a first-class concept so that participants are part of the
Blueprint's own domain model, not a UI-only hint layered on top.

**Explicitly out of scope, deferred to future specs:**
- Owner-facing create/edit UI for Blueprints, their participant templates, or their requirement
  definitions (this pass is read-only + seed data).
- True cross-organization "global" Blueprints (nullable `organization_id`, join-based RLS on child
  tables, updates to the generic cross-tenant isolation sweep). `organization_id` stays `not null`
  everywhere in this pass; a new `is_platform_template` boolean is metadata only, with no visibility
  effect.
- Making Case creation (`createCaseWithParticipants`) atomic. It remains multi-step and
  non-transactional, as it already is today independent of this feature; this is documented, not
  solved, with a forward-looking `TODO` for a future single-RPC-transaction redesign.
- Automated component/UI tests. This codebase has no jsdom/component-testing infrastructure at all
  (`environment: 'node'` only); introducing one is a separate tooling decision, not something to add
  incidentally inside this feature. UI-facing behavior is covered by a manual verification checklist
  instead (see Testing, section F).

## Architecture overview

```
Schema  →  Query layer  →  Wizard  →  Plantillas  →  Seed data
```

Each stage depends on the one before it; the whole thing is one vertical slice, validating the
domain model end to end without yet building any Blueprint-authoring UI.

## 1. Schema migration

### `blueprints`
Adds `is_platform_template boolean not null default false`. Pure semantic metadata — no RLS or
visibility change. `organization_id` stays `not null`, preserving every existing composite-FK, RLS,
and cross-tenant-isolation-sweep pattern unchanged.

### New table `blueprint_participant_templates`
Mirrors `blueprint_stages` exactly:
```sql
create table public.blueprint_participant_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  blueprint_id uuid not null,
  role_key text not null check (length(btrim(role_key)) between 1 and 100),
  display_name text not null check (length(btrim(display_name)) between 1 and 200),
  position integer not null check (position >= 0),
  created_at timestamptz not null default now(),

  foreign key (blueprint_id, organization_id)
    references public.blueprints (id, organization_id) on delete cascade,
  unique (id, organization_id),
  unique (blueprint_id, role_key)
);

create index blueprint_participant_templates_blueprint_idx
  on public.blueprint_participant_templates (blueprint_id, position);
```
RLS: `blueprint_participant_templates_select_by_member` (any org member reads) /
`blueprint_participant_templates_write_by_owner` (owners only, single `for all` policy) — identical
shape to `blueprint_stages`'.

**`blueprint_stages` gains `unique (blueprint_id, position)`.** A duplicate position makes
`stage_position`-based requirement mapping ambiguous, and nothing currently prevents it — the
existing table has no such constraint. Since requirements reference stages by position (not id),
this deserves the same rigor already applied to participant-template positions, arguably more so:
stages are the older, already-relied-upon mechanism. Verified safe to add: no existing test inserts
two stages at the same position for one Blueprint.

`role_key` is a stable, slug-formatted identifier (`buyer`, `seller`, `testator`,
`founding-partner`) — never the display label, which can change/translate. `unique
(blueprint_id, role_key)` is the DB-level guarantee; the query layer additionally validates format
and re-checks uniqueness defensively (see section 2).

### `requirement_definitions` JSON shape
Existing keys (`type`, `label`, `instructions`, `stage_position`) are unchanged. Two new keys:

```json
{
  "key": "official-id",
  "type": "document",
  "label": "INE",
  "scope": "participant",
  "participant_role_key": "buyer",
  "stage_position": 0
}
{
  "key": "appraisal",
  "type": "document",
  "label": "Avalúo",
  "scope": "case"
}
```

- `key` — stable, slug-formatted, required on every definition. Never used as free text; the
  server always persists the Blueprint's own canonical `label`, never client-supplied text.
- `scope` — `'case' | 'participant'`, **explicit**, never inferred from the presence/absence of
  other keys. Absent `scope` defaults to `'case'` (backward-compatible with all pre-existing
  seed/fixture/test data, none of which has a `scope` key).
- `participant_role_key` — required and non-empty when `scope: 'participant'`; must be absent when
  `scope: 'case'`. Either direction violated is a Blueprint integrity error.
- **Key uniqueness is per-bucket, not global.** A bucket is `'case'`, or one specific
  `participant_role_key` — so `buyer/official-id` and `seller/official-id` can coexist (same
  conceptual document, two roles), while two `case`-scope definitions can't both claim `appraisal`.
  Comparison is exact after trimming; keys are validated against a slug format
  (`/^[a-z0-9]+(-[a-z0-9]+)*$/`) and never transformed (no silent lowercasing) at runtime.
- `stage_position` (pre-existing) stays position-based, not key-based, for backward compatibility.
  **Documented technical debt:** migrating requirement definitions to a stable `stage_key` (matching
  the `participant_role_key` pattern) belongs to a future Blueprint-schema revision — `stage_position`
  already works this way for stages today and this pass doesn't need to repeat that mistake for a
  *new* concept, but doesn't need to fix the existing one either.
- **`key` has no production backfill to do.** Unlike `scope` (which must default safely because real
  data predates it), no real Blueprint row exists anywhere yet — no seed data, no CRUD UI has ever
  created one. The only existing places that construct `requirement_definitions` are two test-only
  sites: `tests/helpers/fixtures.ts`'s `BLUEPRINT_DEFINITIONS` and the inline definitions in
  `tests/isolation/case-stages.test.ts`. Both are updated in this same change to include a `key` on
  every entry (3 + 3 entries) — not backfilled via migration, since there is nothing in any real
  database to backfill. This keeps both fixtures usable as inputs to `getBlueprintDefinition` for
  any future test that wants to exercise it against a Blueprint they build.

### `create_case` RPC
The requirement-clone `insert` gains one filter: `where ... and coalesce(definition->>'scope',
'case') = 'case'`. Participant-scoped definitions are never cloned onto the case-level checklist —
they're created per-participant by `createCaseWithParticipants` instead (section 3). This is the
**last-resort backstop only**: the strict query-layer validation (section 2) is the real integrity
gate, since the wizard always reads a Blueprint through that validated path before ever creating a
Case from it. A malformed `scope` value reaching the RPC directly (bypassing the app entirely) is
simply excluded from the case-level clone, never thrown — the RPC does not re-validate `scope`
values itself.

## 2. Query layer

Two functions in `src/features/blueprints/queries.ts`, at deliberately different strictness levels:

```ts
export interface BlueprintSummary {
  id: string;
  name: string;
  description: string | null;
  isPlatformTemplate: boolean;
  stageCount: number;
  participantTemplateCount: number;
  caseRequirementCount: number;
  participantRequirementCount: number;
}

export async function listBlueprintSummaries(
  client: DbClient,
  organizationId: string,
): Promise<BlueprintSummary[]>
```
One query: `blueprints` + embedded `blueprint_stages(id)` + `blueprint_participant_templates(id)` +
raw `requirement_definitions`, `.eq('organization_id', organizationId).order('name')`. Counts
computed in JS, **tolerant of malformed data** — a list of cards must not 500 the whole Plantillas
page over one bad Blueprint elsewhere:
- Missing `scope` → counts as `case`.
- `scope: 'case'` → `caseRequirementCount`.
- `scope: 'participant'` → `participantRequirementCount`.
- Any other value, non-object element, or unreadable definition → **not counted at all** (never
  thrown, never guessed into a bucket).

Error handling: `42501` (permission denied) → `[]`, intentionally matching the existing directory-
query convention (`getClientsDirectory`) even though the UI cannot distinguish permission denial
from a genuinely empty collection; every other query error → throw.

```ts
export async function getBlueprintDefinition(
  client: DbClient,
  blueprintId: string,
  organizationId: string,
): Promise<BlueprintDefinition | null>
```
One query, `.eq('id', blueprintId).eq('organization_id', organizationId).maybeSingle()` (explicit
org filter as defense-in-depth alongside RLS, matching this codebase's existing convention). No row
→ `null`. Query error → throw. Row found → **strict validation**, throwing a plain `Error` (an
internal-consistency bug, not a `UseCaseError` — the same distinction this codebase already draws
elsewhere between infrastructure failures and user-input mistakes) on the first violation of any of:

1. Each `blueprint_participant_templates` row has a `role_key`: present, trimmed, non-empty, slug-
   formatted, and unique within the Blueprint (defensive re-check of the DB constraint — protects
   against inconsistent data in tests/fixtures, not just production writes).
2. `blueprint_participant_templates.position` has no duplicates within the Blueprint.
3. Each requirement definition is a plain object with a `key`: required, trimmed, non-empty, slug-
   formatted, never case-folded.
4. `scope` defaults to `'case'` when absent; if present, must be exactly `'case'` or `'participant'`.
5. `scope: 'participant'` ⟺ `participant_role_key` present, non-empty, and matching a real
   `role_key` from this Blueprint's own (already-fetched, already-validated) participant templates.
   `scope: 'case'` ⟺ `participant_role_key` absent. Either direction violated throws.
6. `stage_position`, if present, must match an actual position in this Blueprint's
   `blueprint_stages`. `blueprint_stages` itself has no duplicate `position` within the Blueprint
   (defensive re-check of the new DB constraint, same reasoning as the `role_key` re-check above).
7. `key` unique within its bucket (`'case'`, or `participant:<role_key>` per role) — cross-bucket
   reuse (e.g. `buyer/official-id` and `seller/official-id`) is expected and fine.
8. Deterministic order: stages and participant templates sorted by `position` in JS (never assumed
   from Supabase's embedded-relation order, which is not guaranteed); requirements keep their JSON
   array order — that order **is** their canonical position, there is no separate ordinal.

Any thrown `Error` here is caught by the calling Server Action exactly as any other unexpected
internal error already is elsewhere in this codebase.

```ts
export interface BlueprintDefinition {
  id: string;
  name: string;
  description: string | null;
  stages: { id: string; name: string; position: number }[];
  participantTemplates: { id: string; roleKey: string; displayName: string; position: number }[];
  requirements: {
    key: string;
    type: string;
    label: string;
    instructions: string | null;
    scope: 'case' | 'participant';
    participantRoleKey: string | null;
    stagePosition: number | null;
  }[];
}
```

## 3. Wizard (`/cases/new`)

**Split into server + client component**, mirroring `/clients` and `/members`:
- `src/app/cases/new/page.tsx` → async Server Component: `requireStaff()` + `createClient()` +
  `listBlueprintSummaries(...)` → passes `blueprints: BlueprintSummary[]` to a client component.
- Existing wizard logic moves to `src/app/cases/new/new-case-wizard.tsx` (client component), same
  steps/UI shell.

**New Server Action** `getBlueprintDefinitionAction(blueprintId)` in `src/app/cases/actions.ts` —
`requireStaff()` + `getBlueprintDefinition(...)`, mapping `null` → `not_found`, a thrown integrity
`Error` → `unexpected`.

**`createCaseWithParticipantsSchema` gains a discriminated union per participant** (this is the
security boundary — `.strict()` on both branches is what actually makes "manual participant cannot
include blueprint-only fields" true, since `z.object()` silently strips unknown keys by default
rather than rejecting them):
```ts
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// Two separate schemas, not one shared with a single max length: role_key's DB column allows only
// 100 chars (blueprint_participant_templates' own check constraint), requirement keys allow 200 —
// the input contract should match what's actually persisted, not just "some slug".
const roleKeySchema = z.string().trim().min(1).max(100)
  .regex(slugPattern, 'Debe ser un identificador en formato slug');
const requirementKeySchema = z.string().trim().min(1).max(200)
  .regex(slugPattern, 'Debe ser un identificador en formato slug');
// Structural validation only — the server still checks every key against the Blueprint's real
// allowlist regardless of whether it's well-formed.

const participantSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('blueprint'),
    participantTemplateRoleKey: roleKeySchema,
    roleLabel: z.string().trim().min(1).max(100),
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320),
    requirementKeys: z.array(requirementKeySchema)
      .refine((keys) => new Set(keys).size === keys.length, 'Duplicate requirement keys'),
  }).strict(),
  z.object({
    source: z.literal('manual'),
    roleLabel: z.string().trim().min(1).max(100),
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320),
    requirements: z.array(z.string().trim().min(1).max(300)), // unchanged freeform trust model
  }).strict(),
]);
```

**`createCaseWithParticipants` orchestration:**
- **When `blueprintId` is present, the Blueprint definition is fetched and strictly validated
  exactly once — regardless of whether any participant is `source: 'blueprint'`.** This closes a
  real bypass: a crafted or foreign `blueprintId` submitted alongside only `'manual'` participants
  would otherwise skip the strict query layer entirely while still reaching `create_case`'s RPC
  clone, contradicting the claim that strict validation is the primary integrity gate. `null` (not
  found / wrong org) → `UseCaseError('not_found', ...)`; a thrown integrity `Error` propagates as an
  unexpected failure, exactly like any other internal error in this codebase.
- Any `source: 'blueprint'` participant with no `blueprintId` on the Case →
  `UseCaseError('validation', ...)` (unchanged).
- Per `'blueprint'` participant: `participantTemplateRoleKey` must match a real
  `participantTemplates` entry — unknown key → `UseCaseError('validation', ...)`, **never** a
  silently-empty requirement set.
- `requirementKeys` are treated as an **allowlist intersection, never an expansion**: filtered
  against that role's allowed keys, then mapped to **the Blueprint's own canonical `label`** —
  client-supplied label text never reaches a blueprint-sourced requirement row. A key that exists
  only under a *different* role is **filtered out**, not rejected — it simply creates no
  requirement for this participant; the request as a whole still succeeds. (This is the same
  narrowing/intersection choice as an unknown key, just phrased for the "valid key, wrong bucket"
  case specifically — nothing about tampering fails the whole request, only excludes what doesn't
  belong.)
- `'manual'` participants: byte-for-byte today's existing, unrestricted behavior — in every
  combination (alone, alongside a Blueprint, mixed with a `'blueprint'` participant in the same
  Case). A manual participant's requirement suggestions are a convenience pool only; it is never
  bound to any `role_key`, and switching Blueprints never retroactively associates one with it, even
  in a future version that might preserve participants across a switch.

**Local `Participant` type mirrors the server's discriminant:**
```ts
type Participant =
  | { id: string; source: 'blueprint'; participantTemplateRoleKey: string;
      role: string; name: string; email: string; selectedRequirementKeys: string[] }
  | { id: string; source: 'manual';
      role: string; name: string; email: string; requirements: string[] };
```
`availableRequirements` is **derived, not stored** — wizard state keeps
`blueprintDefinition: BlueprintDefinition | null`; a `useMemo` builds a
`Map<roleKey, {key, label}[]>` once per definition change, looked up by `StepRequirements` at render
time. One source of truth; no duplicated snapshot to go stale if the definition were ever refetched.

**Step 0** renders real `BlueprintSummary` cards (name, description, the four counts) plus the
synthetic "Expediente en blanco" option (unchanged, `id: null`).

**Choosing a Blueprint** fetches the full definition on demand:
```ts
async function applyBlueprint(summary: BlueprintSummary | null) {
  if (summary === null) {
    setBlueprintId(null); setBlueprintDefinition(null); setTitle(''); setParticipants([]);
    setIsDirty(false); // clearing the wizard is itself an "applied" state, not a dirty one
    return;
  }
  const result = await getBlueprintDefinitionAction(summary.id);
  if (!result.ok) { setFailure(...); return; }
  const def = result.data;
  setBlueprintId(def.id);
  setBlueprintDefinition(def);
  setTitle(def.name); // no trailing separator — the cursor position after "Compraventa ·" was awkward
  setParticipants(
    [...def.participantTemplates].sort((a, b) => a.position - b.position).map((t) => ({
      id: uid(), source: 'blueprint', participantTemplateRoleKey: t.roleKey,
      role: t.displayName, name: '', email: '',
      selectedRequirementKeys: def.requirements
        .filter((r) => r.scope === 'participant' && r.participantRoleKey === t.roleKey)
        .map((r) => r.key), // all selected by default; the user narrows
    })),
  );
  setIsDirty(false); // prefill itself is never "dirty"
}
```
`setIsDirty(false)` appears in both branches rather than once after an `if/else`, since the
blank-case branch returns early — but the *rule* is singular: every successful call to
`applyBlueprint`, blank or real, always ends in a clean state. Missing this on the blank-case path
would otherwise let a stale `isDirty = true` cause the *next* Blueprint pick to open the confirm
modal even though the user just confirmed clearing everything.
```
Manually-added participants (Step 2's existing "Agregar participante" button) are always
`source: 'manual'`, regardless of whether a Blueprint is active.

**`isDirty` tracking** — not participant count. Starts `false`, reset to `false` right after
`applyBlueprint` completes, and set `true` inside every mutator: title change, participant field
edit, add/remove participant, requirement toggle. Picking a Blueprint that auto-generates
participants must never itself count as "dirty" — only actual user edits do.

**Blueprint-switch confirmation** reuses `settings-form.tsx`'s existing overlay-modal pattern (not
`window.confirm`, matching this app's established UI language) — shown only when `isDirty`;
confirming calls `applyBlueprint`, cancelling leaves everything untouched.

**Step 3 pool logic:**
- `source: 'blueprint'`: pool = that role's entry in the derived `Map`; toggling mutates
  `selectedRequirementKeys`.
- `source: 'manual'`: pool = the union of every participant-scoped requirement label across the
  active Blueprint (a convenience suggestion set for an extra, non-templated participant), falling
  back to today's hardcoded generic pool (`["INE", "CURP", "Comprobante de domicilio"]`) when no
  Blueprint is active or it defines nothing.

**Submission** maps each participant to its matching discriminated shape:
```ts
const response = await createCaseAction({
  title,
  blueprintId: blueprintId ?? undefined,
  participants: participants.map((p) =>
    p.source === 'blueprint'
      ? { source: 'blueprint', participantTemplateRoleKey: p.participantTemplateRoleKey,
          roleLabel: p.role, fullName: p.name, email: p.email, requirementKeys: p.selectedRequirementKeys }
      : { source: 'manual', roleLabel: p.role, fullName: p.name, email: p.email, requirements: p.requirements }
  ),
  sendInvitations: true,
});
```
No change needed to `createCaseAction` itself.

**Atomicity, documented not solved:** a comment in `createCaseWithParticipants` states that creation
is multi-step and non-transactional, a failure partway through can leave a partial Case, and there is
no idempotency key — blind resubmission risks a duplicate. Includes a forward-looking
`// TODO: move participant + requirement + case creation into a single RPC transaction once this
needs to be atomic.` The `FailureBanner`'s "unexpected" copy gains one line: *"Puede que el
expediente ya se haya creado parcialmente. Revisa Expedientes antes de reintentar."*

## 4. Plantillas (`/blueprints`)

Converts to the same read pattern: async Server Component (`requireStaff` + `createClient` +
`listBlueprintSummaries`) → `BlueprintsDirectory` client component. Cards show all four
broken-out counts (stages, participant roles, case-level requirements, participant-level
requirements) — not one total — so the model's correctness is visible at a glance. The synthetic
"datos de demostración sintéticos" disclaimer footer is removed. No detail/expand view and no
create/edit UI in this pass.

## 5. Seed data

`scripts/seed-demo.mjs` gains 4 Blueprints, each `is_platform_template: true`:

| Blueprint | Participant templates | Requirement shape |
|---|---|---|
| Compraventa | `buyer` (Comprador), `seller` (Vendedor) | Both roles define an `official-id` key (proves bucket-scoped uniqueness in practice — same key, two buckets, no collision), plus a case-scoped `appraisal` |
| Testamento | `testator` (Testador) | Participant-scoped requirements only |
| Constitución de sociedad | `founding-partner` (Socio fundador) | Mix of role-specific + case-scoped; one suggested role (repeatable roles explicitly out of scope for MVP) |
| Poder notarial | *(none)* | Case-scoped requirements only — the "no participant templates" path |

Covers every shape the model needs to prove itself: multi-role, single-role, and role-less
Blueprints, cross-bucket key reuse, and a mix of case/participant-scoped requirements.

## 6. Testing

### Automated, must-have (A–D) — buildable with zero new tooling

**A. `create_case` RPC integration tests** (extends `tests/isolation/case-stages.test.ts` or a
sibling file) — a case-scoped definition clones onto the case-level checklist; a participant-scoped
definition does not; a definition with no `scope` defaults to `'case'`; a malformed/unknown `scope`
is excluded from cloning (not relied on for integrity — the query layer is the real gate); a
Blueprint mixing both scopes clones only the case-scoped subset; existing non-blueprint Case
creation is unchanged. Assertions check exact labels/keys cloned, not just counts.

**B. Query-layer tests** (`getBlueprintDefinition`, `listBlueprintSummaries`) — every valid case
(valid case-scoped requirement; valid participant-scoped requirement; missing `scope` defaults;
same key reused across different participant-role buckets; same key reused between `case` and a
participant bucket; requirements preserve JSON array order; stages/participant templates sorted by
`position`) and every invalid case, each throwing a plain `Error`: not a plain object; missing key;
empty/whitespace key; invalid slug format; invalid `scope`; `participant` scope without
`participant_role_key`; `case` scope with `participant_role_key`; empty participant role key;
orphaned participant role key; duplicate key in the case bucket; duplicate key within the same
participant-role bucket; duplicate participant-template position; invalid/duplicate participant
template `role_key`; `stage_position` referencing a nonexistent stage; duplicate `blueprint_stages`
position. `listBlueprintSummaries`
separately: counts valid case/participant definitions; treats missing scope as case; ignores
malformed/unknown definitions for counting; `42501 → []`; other DB errors throw; one malformed
Blueprint never fails the whole list.

**C. Input-schema tests** (Zod discriminated union) — blueprint participant requires
`participantTemplateRoleKey` and accepts `requirementKeys`; manual participant accepts freeform
`requirements` and cannot include blueprint-only fields; blueprint participant cannot use the
manual shape; duplicate/empty `requirementKeys` rejected; a payload cannot omit or use an unknown
`source`.

**D. `createCaseWithParticipants` orchestration tests** — the security-sensitive core. The Blueprint
definition is fetched and validated exactly once whenever `blueprintId` is present on a *valid*
payload, **regardless of participant sources** — including a case with only `'manual'` participants,
a role-less Blueprint, and a crafted/foreign `blueprintId` bypassing the wizard entirely (→
`UseCaseError('not_found')`, never silently ignored). A payload with an empty participants array is
rejected by the input schema before orchestration ever runs — that's an existing, unrelated
`min(1, ...)` rule, not a case this fetch-once behavior needs to cover, since
`createCaseWithParticipants` is never called with it in the first place. Missing `blueprintId` on a
`'blueprint'` participant / an unknown role key → `UseCaseError('validation')`. Selected allowed
keys create requirements; deselected allowed keys are omitted; injected unknown keys are filtered
out (the request still succeeds); persisted labels come from the Blueprint, never client input; a
key defined only under a *different* role is **filtered out** for the current participant — it
creates no requirement, but does not fail the request (never a "rejection" of the whole payload);
duplicate keys never reach orchestration at all, since the strict, slug-validated schema rejects
them first. Manual participants: existing freeform behavior unchanged, with no Blueprint, with an
active Blueprint, never resolved through a role key, never filtered against any allowlist. Mixed:
one blueprint participant + one manual participant created correctly in the same Case.

### Manual verification checklist (E/F) — not automated tests this repo can currently support

Run during implementation, recorded in the PR, since introducing jsdom/React Testing Library here
would expand scope into a separate testing-infrastructure initiative (new deps, environment config,
mocking conventions, this codebase's first component-test pattern) rather than something to add
incidentally inside this feature.

```
## Manual verification

Wizard
- [ ] /cases/new loads the real blueprint summaries
- [ ] Selecting a blueprint fetches and applies its definition
- [ ] Prefill leaves isDirty = false
- [ ] Editing the title, participant data, participants, or requirements marks the wizard dirty
- [ ] Switching while clean applies immediately
- [ ] Switching while dirty opens the in-app confirmation modal
- [ ] Cancelling preserves all current state
- [ ] Confirming applies the new blueprint and resets dirty state
- [ ] Selecting "Expediente en blanco" clears blueprintId, definition, participants, and title
- [ ] Blueprint participants start with all role-specific requirements selected
- [ ] Users can deselect requirements
- [ ] Manual participants receive suggestion options but remain manual
- [ ] A role-less blueprint (Poder notarial) works correctly
- [ ] Submission creates the expected case and participant requirements
- [ ] A simulated unexpected partial failure shows the revised warning copy

Plantillas
- [ ] /blueprints renders seeded records from the database
- [ ] Each card shows the four distinct counts
- [ ] Counts match the seeded definitions
- [ ] No synthetic-data disclaimer remains
- [ ] No create, edit, or detail controls are exposed
- [ ] Empty and permission-denied states render without crashing

Browser tested:
- [ ] Chrome
```
