# DocuFlow architecture

What a new contributor needs before touching the schema or the access model. Product truth lives
in [`PRODUCT.md`](../PRODUCT.md); the reasoning behind each decision lives in
[`openspec/changes/initial-multi-tenant-schema/design.md`](../openspec/changes/initial-multi-tenant-schema/design.md).

## The one-paragraph version

A **Case** is the central object. **Requirements** are what a Case needs; a document is one
requirement type among planned peers, never the centre of the system. **Blueprints** seed Cases
and then stop mattering. A **Client** is the Organization's durable record of a person; **Case
Access** is a separate, expiring, revocable grant that lets that person reach exactly one Case.
Every table is scoped to an **Organization**, and the database — not the application — is what
enforces it.

## The authorization resolvers

Two `SECURITY DEFINER` functions in the `app` schema answer every authorization question:

| Function | Answers |
|---|---|
| `app.member_org_ids()` | Which Organizations is the caller a Member of? |
| `app.is_org_owner(uuid)` | Does the caller own this Organization? |
| `app.granted_case_ids(min_permission)` | Which Cases does the caller hold an active grant on, at or above this permission? |

Every policy is one of these, or both composed with `or`:

```sql
using (
  organization_id in (select app.member_org_ids())
  or case_id in (select app.granted_case_ids('view'))
)
```

**These functions are the privilege boundary of the entire product.** They run as their owner and
see every row. A defect in one is a cross-tenant breach, not a bug. When changing them:

- no dynamic SQL, ever;
- `search_path` stays pinned to `''`, every name stays schema-qualified;
- keep them `STABLE`, so the planner evaluates them once per statement rather than once per row;
- they answer entitlement questions and nothing else.

`schema-guard.test.ts` enforces the pinned `search_path` and the `STABLE` marking, and fails if
any `app` function becomes executable by `anon`.

### Why not JWT claims

Putting `organization_id` and `role` in the token is the common Supabase pattern and is faster.
It was rejected because a JWT is a snapshot: a revoked grant or a removed Member stays authorized
until the token refreshes. The product requires revocation to take effect on the next request.
The flat `organization_id` column below is what buys the performance back.

### Why `SECURITY DEFINER` is load-bearing on `members`

A policy on `members` that queried `members` would re-enter its own policy and recurse. The
function bypasses RLS internally and breaks the cycle. For that reason **`members` must never be
switched to `FORCE ROW LEVEL SECURITY`**, which would subject the owner to policies and restore
the recursion.

## The composite foreign key pattern

Every business table carries `organization_id` directly, so no policy walks
`documents → requirements → cases` to find the tenant. Denormalization normally invites drift. It
cannot drift here, because each child declares a composite foreign key against its parent's
`(id, organization_id)` key:

```sql
create table public.requirements (
  ...
  foreign key (case_id, organization_id)
    references public.cases (id, organization_id)
);
```

A row whose `organization_id` disagrees with its parent is rejected by the database. Flat-check
performance with walked-check integrity.

**When you add a table**, it needs all of:

1. `organization_id`, not null;
2. a composite foreign key to its parent's `(id, organization_id)`;
3. `unique (id, organization_id)` if anything will ever reference *it*;
4. `enable row level security` in the same migration;
5. an explicit `grant` — this Supabase version does not auto-expose new tables, so a missing
   grant fails closed;
6. an entry in the cross-tenant sweep.

Steps 4 and 6 are enforced by tests. The rest are on you.

## The grant lifecycle

```
                 issueInvitation()
                        │
                        ▼
                    ┌────────┐   OTP verified    ┌────────┐
                    │pending │ ────────────────▶ │ active │
                    └────────┘                   └────────┘
                                                   │  │  │
                        expires_at passes ─────────┘  │  └───── revoked_at set
                                                      │
                                        Case completed│
                                                      ▼
                                    permission → view, expires_at → now + retention
```

Two things are tracked separately and both are evaluated:

- **Lifecycle** — `verified_at`, `revoked_at`, `expires_at`.
- **Permission** — `upload`, `view`, `none`, in its own column.

Neither implies the other. That separation is what makes Case completion cheap: a trigger sets
`permission = 'view'` and `expires_at = now() + the Organization's retention window`. No new
state, no special case in any policy.

**Expiry is evaluated at read time**, inside `app.granted_case_ids()`. There is no scheduled job,
deliberately: a cron that fails to run leaves access open, while a predicate that fails to run
returns no rows. The failure mode points at denial.

## The invitation and OTP flow

The security property is that **holding the invitation link is never enough**.

1. Staff issue an invitation. The clear-text token is returned once and never stored — only its
   SHA-256 hash goes in the row.
2. A visitor opens the link. They see the Organization name and Case title. No client name, no
   requirement list, no documents.
3. They request a code. **The address is read from the grant row.** There is no parameter that
   could carry a different one, which is what stops this from becoming an account-enumeration or
   mail-bombing endpoint.
4. They submit the code. On success the grant is bound to the verified `auth.users.id`, given its
   90-day TTL, and the Organization's Client record picks up the same identity.

The passcode email deliberately contains a code and not a clickable link
(`supabase/templates/magic_link.html`). A link in a mailbox is a bearer credential that survives
forwarding; a code has to be read by a person and typed into the session that asked for it.

Throttling lives on the grant: a 60-second resend cooldown and a 5-attempt lockout. Attempts are
audited; submitted codes never are.

## One person, many organizations

A real person is a client of many businesses over a lifetime. The rule that makes this safe:

> **Identity may be shared. Data never is.**

One verified email maps to one `auth.users` row, which may be linked to Client records in many
Organizations. That link is the only permitted connection between tenants and **grants no read
access by itself** — every read stays authorized by a Case Access grant.

Consequences that must not be broken:

- Client email is unique **per Organization**, never globally. A global unique index would leak
  cross-tenant presence through conflict errors.
- No Organization may learn that a person is also a client elsewhere. Cross-tenant existence is
  itself confidential.
- Documents belong to the Organization that collected them. There is no automatic reuse.

## Storage

Objects live at:

```
{organization_id}/cases/{case_id}/requirements/{requirement_id}/{document_id}
```

Storage policies parse folder 1 (tenant) and folder 3 (Case) and apply the same resolvers as
table policies, so storage and tables cannot disagree. Paths are built in exactly one place,
`src/lib/storage/paths.ts` — build them anywhere else and you risk a shape the policies read
differently. Buckets are private; reads are 120-second signed URLs, never persisted.

## The audit trail

Append-only. `audit_events` has INSERT and SELECT policies, no UPDATE or DELETE policy, and
`update, delete` revoked from every application role including `service_role`.

Events must outlive their subjects, so `target_id` carries **no foreign key** and each event
holds a jsonb metadata snapshot. Deleting a Requirement leaves its history readable.

Never write a passcode, session token, signed URL, or file content into an event.
`recordAuditEvent` refuses a metadata key that looks like one, but the real rule is not to pass
it.

## Testing

`npm test` runs against a local Supabase stack.

Tests drive the database **through the PostgREST boundary as each principal**, never as the
service role. The service role bypasses RLS and would pass against a schema with no policies at
all — which is precisely the failure the suite exists to catch. The service role appears only in
fixture construction, and in the narrow production paths documented in
`src/lib/supabase/admin.ts`.

The OTP tests go through real email delivery into the local Mailpit inbox, because the property
under test is *which mailbox the code reaches*. A stubbed code would pass even if the address
came from the caller.
