## 1. Project and Supabase Setup

- [x] 1.1 Initialize the Next.js + TypeScript project with strict compiler settings, Tailwind, and feature-based directory structure
- [x] 1.2 Add Supabase CLI, initialize local development, and commit `supabase/config.toml`
- [x] 1.3 Choose and record the Supabase project region, resolving the data residency open question from design.md
- [x] 1.4 Add Vitest and the test scripts; confirm a local Supabase instance can be started and reset from a single command
- [x] 1.5 Add Zod and set up the server-side validation module boundary

## 2. Authorization Foundation

- [x] 2.1 Create the `app` schema and migration for extensions
- [x] 2.2 Implement `app.member_org_ids()` as `SECURITY DEFINER STABLE` with pinned `search_path` and no dynamic SQL
- [x] 2.3 Implement `app.granted_case_ids(min_permission)` as `SECURITY DEFINER STABLE`, treating a grant as active only when verified, not revoked, and not expired
- [x] 2.4 Revoke direct execute from public roles where inappropriate and document each function as security-critical
- [x] 2.5 Write unit tests for both resolvers covering: no membership, single org, multi-org, expired grant, revoked grant, unverified grant, and each permission level

## 3. Organizations and Members

- [x] 3.1 Create `organizations` with industry column and `(id)` plus `(id, organization_id)`-style unique keys needed by child composite foreign keys
- [x] 3.2 Create `members` linking `auth.users` to an organization with a role CHECK constrained to `owner` and `staff`
- [x] 3.3 Enable RLS and write policies: members read their own organizations; only owners insert, update, or delete member rows; no cross-organization reach
- [x] 3.4 Verify the recursive-RLS trap is avoided — the `members` policy must resolve through the `SECURITY DEFINER` function, not a self-referencing subquery
- [x] 3.5 Test staff cannot modify membership, owner cannot reach a second organization, and industry does not branch policy behavior

## 4. Clients and Identity

- [x] 4.1 Create `clients` scoped to an organization with a nullable `auth_user_id` referencing `auth.users`
- [x] 4.2 Constrain client email uniqueness per organization, never globally, so cross-tenant presence cannot be inferred from a conflict
- [x] 4.3 Enable RLS and write policies restricting client reads and writes to members of the owning organization
- [x] 4.4 Test that the same email creates independent client rows in two organizations with no conflict, warning, or shared field
- [x] 4.5 Test that an authenticated user with no grant reads zero rows, including when their email matches an invited client

## 5. Blueprints, Cases, and Requirements

- [x] 5.1 Create `blueprints` with ordered requirement definitions, organization scoped, owner-only writes
- [x] 5.2 Create `cases` with lifecycle state and nullable `origin_blueprint_id` using `ON DELETE SET NULL`
- [x] 5.3 Create `requirements` with `type` CHECK constraint covering all planned types, `config jsonb`, ordering, and `deleted_at`
- [x] 5.4 Add composite foreign keys tying every child's `organization_id` to its parent's `(id, organization_id)` so denormalization cannot drift
- [x] 5.5 Implement the clone operation as a deep copy of requirement definitions into new requirement rows
- [x] 5.6 Add the active-requirements view that applies `deleted_at IS NULL` in one place
- [x] 5.7 Enable RLS and write policies for all three tables covering both member and granted-client principals
- [x] 5.8 Reject non-document requirement types at the application boundary with an explicit unsupported-type error
- [x] 5.9 Test blueprint independence: editing, reordering, and deleting a blueprint leaves cloned cases unchanged
- [x] 5.10 Test per-case requirement add, rename, delete, and reorder affect neither sibling cases nor the blueprint

## 6. Case Access Grants

- [x] 6.1 Create `case_access_grants` with `client_id`, `case_id`, `organization_id`, `auth_user_id`, `invited_email`, `permission`, `verified_at`, `revoked_at`, `expires_at`, and an opaque invitation token
- [x] 6.2 Add indexes supporting read-time activity evaluation on `case_id`, `auth_user_id`, `expires_at`, `revoked_at`, and `verified_at`
- [x] 6.3 Implement invitation issuance: generate the opaque token, store the invited email, and leave the grant pending
- [x] 6.4 Implement the invitation endpoint returning case context only, with no client names, requirement detail, or document data
- [x] 6.5 Implement OTP dispatch that reads the invited email from the grant row and never accepts a user-supplied address
- [x] 6.6 Implement OTP verification binding the resulting `auth.users.id` to the grant and setting `verified_at` and the 90-day default `expires_at`
- [x] 6.7 Add OTP rate limiting with cooldown, recording failures as audit events without storing the submitted code
- [x] 6.8 Add the case-completion trigger downgrading active grants to `view` and setting `expires_at` to the configurable retention window
- [x] 6.9 Implement staff revocation and reissue, where reissue reuses the existing client rather than creating a duplicate
- [x] 6.10 Enable RLS and write policies for grants
- [x] 6.11 Test that a forwarded invitation URL grants nothing without mailbox access
- [x] 6.12 Test each permission level, expiry, revocation taking effect on the next request, and completion downgrade behavior

## 7. Documents, Storage, and Reviews

- [x] 7.1 Create the private storage bucket with public access disabled and verify no bucket serving documents is publicly readable
- [x] 7.2 Centralize storage path construction as `{organization_id}/cases/{case_id}/requirements/{requirement_id}/{document_id}` in one server module
- [x] 7.3 Create `documents` recording file name, content type, size, and storage path
- [x] 7.4 Create `reviews` recording decision, reviewing member, timestamp, and optional client-visible rejection reason
- [x] 7.5 Write `storage.objects` policies parsing the leading path segment and applying the same resolvers as table policies
- [x] 7.6 Implement signed URL issuance with a short expiry, only after policy evaluation, never persisted
- [x] 7.7 Enforce content type allowlist and maximum size on upload, rejecting before any document row is created
- [x] 7.8 Implement approve and reject, where approval satisfies the requirement and rejection reopens it while preserving prior review history
- [x] 7.9 Enable RLS and write policies for documents and reviews, including denying client inserts into reviews
- [x] 7.10 Test cross-tenant signed URL refusal, expired signed URL refusal, and direct object URL refusal when unauthenticated
- [x] 7.11 Test that a view-only client cannot upload and that a client cannot upload to an ungranted case

## 8. Audit Trail

- [x] 8.1 Create `audit_events` with a real `organization_id` foreign key, and `target_type` plus `target_id` without foreign keys, plus a jsonb metadata snapshot
- [x] 8.2 Add actor columns distinguishing member, client-via-grant, and system actors
- [x] 8.3 Enable RLS with INSERT and SELECT policies only, and additionally revoke UPDATE and DELETE from application roles
- [x] 8.4 Emit audit events from every consequential action: case create and state change, requirement add, rename, delete and reorder, grant issuance, OTP success and failure, permission change, revocation, document upload, review decision, and member changes
- [x] 8.5 Test that update and delete are denied, that events outlive a deleted requirement, and that clients read zero audit rows
- [x] 8.6 Test that no audit event contains an OTP code, session token, signed URL, or file content

## 9. Isolation Verification

- [x] 9.1 Build the two-organization fixture with overlapping client emails and populated cases, requirements, documents, and grants
- [x] 9.2 Build the test harness that authenticates as each principal through the PostgREST boundary, explicitly not as the service role
- [x] 9.3 For every table, assert a member of organization A cannot read rows of organization B
- [x] 9.4 For every table, assert a member of organization A cannot update or delete rows of organization B
- [x] 9.5 Assert responses for a real organization B id are indistinguishable from responses for a nonexistent id
- [x] 9.6 Assert a granted client sees exactly one case and no sibling case of the same client
- [x] 9.7 Assert one auth identity holding grants in two organizations sees each independently, and revocation in one does not affect the other
- [x] 9.8 Add a schema guard test asserting every table in the exposed schema has RLS enabled and at least one policy

## 10. Integration and Handoff

- [x] 10.1 Generate TypeScript types from the schema and wire them into the application
- [x] 10.2 Implement the explicit organization route parameter validated against `member_org_ids()` on every request
- [x] 10.3 Add the GitHub Actions workflow running migrations, type generation check, and the full test suite including section 9
- [x] 10.4 Document the resolver functions, the composite foreign key pattern, and the grant lifecycle for future contributors
- [x] 10.5 Record the resolved values for retention window and client session lifetime, closing those open questions in design.md
