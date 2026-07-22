## Context

DocuFlow starts from an empty repository with a confirmed product record (`PRODUCT.md`) and no code. This change lays the database foundation: the core domain tables, the tenant boundary, and the client access model.

The binding constraints come from `PRODUCT.md` and are not open for renegotiation here: multi-tenant from day one, RLS on every exposed table, no public storage buckets, signed URLs only, temporary client sessions, an audit event for every important action, and no trust in client-side authorization. The stack is Supabase (Postgres, Auth, Storage) with Next.js and TypeScript.

Two principals share one authentication system. **Members** (Owner, Staff) act inside one Organization. **Clients** are external people who reach exactly one Case through a grant. Both authenticate as `auth.users`; what separates them is what the database will let them see.

## Goals / Non-Goals

**Goals:**

- A schema where organization isolation is a property of the database, provable by test, not a convention maintained by application code.
- A `Client` / `Case Access` split that lets a returning person keep their history, and lets one human hold access across multiple organizations without any of them sharing or detecting data.
- Revocation and permission changes that take effect on the next request, with no dependence on token refresh.
- A `Requirement` shape where `document` is one type among peers, so payments, signatures, and forms are additive rather than structural.
- Blueprint independence guaranteed by data layout, not by developer discipline.

**Non-Goals:**

- Reminder delivery and the email pipeline (follow-up change).
- Any application UI.
- Requirement types other than `document`.
- The unified cross-organization client view, and cross-organization document reuse. This design must leave both reachable without data migration; it must not build either.

## Decisions

### D1: Authorization reads from tables, never from JWT claims

Membership and grants are resolved per request by querying Postgres, exposed to policies through `SECURITY DEFINER` helper functions marked `STABLE` so each is evaluated once per statement rather than once per row.

**Alternative rejected — organization id and role as custom JWT claims.** Faster, and the common Supabase pattern. But a JWT is a snapshot: a revoked grant or a removed Member stays authorized until the token refreshes. That directly contradicts the requirement that revocation takes effect on the next request without waiting for token refresh. Security requirement wins over the performance shortcut; D3 buys the performance back.

The helper functions are the privilege boundary of the whole system. They stay small, contain no dynamic SQL, and pin `search_path` explicitly.

### D2: Two principal resolvers, composed in every policy

```
app.member_org_ids()               -> set of organization_id where the caller is a Member
app.granted_case_ids(min_permission) -> set of case_id where the caller holds an active grant
```

A grant is active when `verified_at IS NOT NULL AND revoked_at IS NULL AND now() < expires_at` and its permission meets the requested level. Expiry is therefore evaluated at read time; no scheduled job is required for access to lapse, and a missed cron run can never leave access open.

Policies read as: visible if the row's organization is in `member_org_ids()`, **or** the row's case is in `granted_case_ids(...)`. Being a Member is deliberately not sufficient for storage objects belonging to another organization, because the org check is on the row, not on the caller.

`SECURITY DEFINER` also resolves the recursive-RLS trap: a policy on `members` that queries `members` deadlocks on itself. The function bypasses RLS internally, so it breaks the cycle.

### D3: `organization_id` is denormalized onto every business table, held true by composite foreign keys

Every business table carries `organization_id` directly, so no policy walks the tree from `documents` to `reviews` to `requirements` to `cases` to reach a tenant check.

Denormalization normally invites drift. It cannot drift here: each child declares a composite foreign key against the parent's `(id, organization_id)` unique key.

```sql
requirements.(case_id, organization_id)
  REFERENCES cases(id, organization_id)
```

A row whose `organization_id` disagrees with its parent is rejected by the database. The performance of a flat check with the integrity of a walked one.

### D4: Grant state and permission are separate columns

Lifecycle (`pending` → `active` → `expired` | `revoked`) is expressed by `verified_at`, `revoked_at`, and `expires_at`. Permission (`upload`, `view`, `none`) is its own column. Both are evaluated; neither implies the other.

This is what makes case completion cheap. A trigger on `cases` completion sets `permission = 'view'` and `expires_at = now() + retention_window` on active grants. No new state, no special case in policy, no separate "completed access" concept. The rolling 90-day TTL and the post-completion retention window are the same mechanism with different values.

**Alternative rejected — deriving permission from case state at read time.** It couples two lifecycles and makes "extend this one client's access" impossible without a special case.

### D5: The invitation token never carries access, and the client never types their email

The invitation URL carries an opaque token identifying a pending grant. Opening it returns Case context only — no client names, no requirement detail, no documents. The server reads the invited email **from the grant row** and sends the OTP there. The visitor submits only the code.

This closes two holes at once. A forwarded or intercepted URL is useless without the mailbox. And because the email is never user-supplied, `signInWithOtp` cannot be turned into an account-enumeration or mail-bombing endpoint — a real risk if the client-facing form accepted an arbitrary address.

On successful verification, Supabase Auth creates or reuses the `auth.users` row for that verified email, and the grant stores that `auth.users.id`. From then on the grant is bound to the identity, not to the address.

### D6: Cloning a Blueprint is a deep copy with a non-enforcing origin reference

Case creation copies requirement definitions into new `requirements` rows. `cases.origin_blueprint_id` is nullable with `ON DELETE SET NULL`, kept for provenance only; nothing reads it during Case operation. Blueprint independence is guaranteed by there being no live reference to follow.

### D7: One `requirements` table, discriminated by `type`, with type-specific fulfillment in its own table

`requirements` holds `type` (CHECK-constrained), ordering, label, and a `config jsonb` for type-specific settings validated by Zod server-side. Fulfillment that needs relational integrity gets a real table — `documents` for `document`. Future types add their own fulfillment table if they need one; `payment` will, `confirmation` will not.

**Alternatives rejected.** Table-per-requirement-type multiplies joins and policies for a system whose whole point is that requirements are uniform. Nullable columns per type sprawl the table with every addition. Pure `jsonb` fulfillment abandons the integrity that documents and reviews need.

Only `document` is accepted at the application boundary in this change. The other type values exist in the constraint so enabling one later is a handler plus a constraint edit, never a structural migration.

### D8: Requirements soft-delete; audit events reference targets without foreign keys

`requirements.deleted_at` keeps deleted requirements out of the active Case while their history stays intact.

`audit_events` holds `organization_id` with a real FK (RLS depends on it) but stores `target_type` and `target_id` **without** a foreign key, plus a jsonb metadata snapshot. Audit rows must outlive their subjects; an FK would either block deletion or cascade the evidence away. The snapshot means an event stays readable even when the row it describes is gone.

### D9: Audit immutability is enforced by absent policies and revoked grants

`audit_events` gets INSERT and SELECT policies and no UPDATE or DELETE policy, with `UPDATE, DELETE` additionally revoked from application roles. RLS denies by default, so a missing policy is already a denial; the revoke is the second lock.

### D10: Storage paths lead with the tenant, and storage policies use the same resolvers

```
{organization_id}/cases/{case_id}/requirements/{requirement_id}/{document_id}
```

Policies on `storage.objects` parse the leading path segment and apply D2's resolvers, so storage and tables cannot disagree about who may read what. Buckets are private. Reads are short-lived signed URLs issued only after policy evaluation.

### D11: Organization context is explicit in the route, validated against membership

A user who is a Member of two Organizations acts in one at a time. The active Organization is an explicit route parameter, validated against `member_org_ids()` on every request — not a "current organization" stored in the session or the JWT, which reintroduces the staleness D1 rejected.

### D12: Isolation is verified by negative tests, in this change

A fixture builds two Organizations with overlapping client emails. For every table, tests assert that a Member of A cannot read, write, or detect rows of B, and that responses for a real B id are indistinguishable from responses for a nonexistent id. Tests run through the PostgREST boundary as each principal, not as the service role, since the service role bypasses RLS and would pass a broken schema.

## Risks / Trade-offs

- **A defect in a `SECURITY DEFINER` helper is a full tenant breach, not a bug** → keep the functions minimal and free of dynamic SQL, pin `search_path`, review them as security-critical code, and cover them directly in D12's tests.
- **Read-time expiry evaluation adds predicate cost to every query** → `expires_at`, `revoked_at`, and `verified_at` are indexed alongside `case_id`; `STABLE` functions are evaluated once per statement. Accepted deliberately: a cron-based expiry that fails leaves access open, and this cannot.
- **Denormalized `organization_id` is redundant data** → composite foreign keys make an inconsistent row unrepresentable. The redundancy is enforced, not trusted.
- **Composite foreign keys require a unique constraint on `(id, organization_id)` for every parent** → mechanical extra constraint per table; small and predictable cost.
- **Soft-deleted requirements can leak into queries if a `deleted_at IS NULL` filter is forgotten** → expose active requirements through a view used by application code, keeping the filter in one place.
- **`config jsonb` has no database-level shape guarantee** → Zod schemas per requirement type, versioned, validated server-side on every write.
- **Signed URLs are bearer tokens for their lifetime** → short expiry, issued per request, never persisted, never written into audit events.
- **Storage policies parsing a path string are more fragile than a foreign key** → path construction is centralized in one server module, and D12 covers cross-tenant object access directly.
- **RLS makes some future queries awkward to optimize** → accepted. Correctness of the tenant boundary outranks query ergonomics, and the flat `organization_id` keeps the common paths simple.

## Migration Plan

This is the initial schema; there is nothing to migrate from and no rollback of user data to consider.

1. `app` schema and shared trigger helpers.
2. `organizations` and `members`, then `app.member_org_ids()`, then their policies.
3. `clients`.
4. `blueprints`.
5. `cases` and `case_access_grants`, then `app.granted_case_ids()`, then policies for both.
6. `requirements`.
7. `documents` and `reviews`.
8. `audit_events`, with its insert-and-select-only policy set.
9. Private storage buckets and `storage.objects` policies.
10. Generated TypeScript types, two-organization seed fixture, and the D12 isolation suite.

Each step is one migration file, ordered and applied forward only.

**Ordering within a migration is table → resolver → policy.** A resolver reads the tables it authorizes against, so it cannot be created before them; a policy calls the resolver, so it cannot be created before that. Steps 2 and 5 therefore create a table pair and the resolver that spans them together rather than splitting across migrations.

This preserves the invariant that no table is ever exposed unprotected. RLS is enabled on the same statement block that creates the table, and an RLS-enabled table with no policy denies everything — the window between `enable row level security` and the first `create policy` is closed, not open.

**Tables are not reachable until explicitly granted.** This Supabase version does not auto-expose new tables to the API roles, so each migration issues the specific `grant` its policies are designed to constrain. A missing grant fails closed.

## Resolved Decisions

These were open when this design was written and were settled before implementation began.

### R1: Data residency — `us-east-1`

The hosted Supabase project targets `us-east-1` (N. Virginia). No jurisdictional storage requirement was identified that would force a different region for the initial notary market.

### R2: Retention window — an Organization policy, defaulting to 90 days

The post-completion read-only window is stored as `organizations.access_retention_days`, defaulting to 90. It is **not** hardcoded and **not** exposed in the UI for the MVP; the column exists so a later release can surface it per Organization without a schema change or a change to grant logic.

The completion trigger reads the owning Organization's value rather than a constant, so differing retention policies require no code change — only a different row value.

### R3: Client session — one hour of **inactivity**, under a 24-hour absolute ceiling

The authenticated client session carries two bounds, configured via `auth.sessions`:

- **`inactivity_timeout = "1h"`** — the sliding bound. A client actively uploading is never interrupted mid-task; a client idle for an hour re-authenticates with a fresh OTP.
- **`timebox = "24h"`** — the absolute ceiling. No session outlives a day regardless of activity.

The ceiling was added deliberately after the sliding bound was chosen, because the two answer different failure modes. Inactivity handles the ordinary case: someone wanders off. It does nothing about a session that stays busy — a device left signed in on a shared machine, or a stolen refresh token being exercised. **Activity is precisely what an attacker in possession of a session produces**, so a purely sliding bound renews itself in exactly the scenario it should be closing. The timebox is the bound that cannot be extended by using it.

Neither bound is grant lifetime. The Client identity and the Case Access grant remain valid across session expiry — re-entry costs a passcode, not a new invitation. Session expiry is an authentication event; grant expiry is an authorization event. Conflating them would either force needless re-invitation or keep sessions alive far longer than is safe.

## Open Questions

- **Whether `staff` should later be scopeable to a subset of Cases.** Not needed for the MVP's small teams, and the grant model would extend to it, but confirming it is out of scope now prevents premature generalization.
