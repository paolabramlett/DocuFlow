# Client Portal Upload Progress + Cancel — Design

**Goal:** Replace the Client Portal's opaque, unresponsive document upload (a single Server Action that proxies the whole file through the Next.js server) with a real, byte-accurate progress bar and a genuine mid-transfer cancel — without weakening any of the authorization/validation the current flow already enforces.

**Architecture:** A three-phase flow — `prepare` (Server Action, authorization + reserve a storage path + mint a signed upload URL) → `upload` (the browser, via `XMLHttpRequest`, direct to Supabase Storage — no Next.js server in the byte path) → `finalize` (Server Action + an atomic Postgres RPC, validates the real uploaded object and registers the `documents` row). A new `document_upload_sessions` table tracks each attempt through an explicit state machine, closing every race between finalize, cancel, and a cleanup job.

**Tech Stack:** Next.js 16 Server Actions, `XMLHttpRequest` (browser), Supabase Storage signed upload URLs, a new `plpgsql` RPC, `pg_cron` (matching this project's existing reminder-cron convention).

## Global Constraints

- Every RPC exception uses `raise exception using errcode = 'P0001', message = 'stable_snake_case_code'` — this project's established convention.
- Authorization is a plain, non-locking SELECT before any `FOR UPDATE` lock, in every RPC.
- Copy is Spanish (Mexico).
- Server Actions never call `redirect()`; they return `ActionResult<T>`.
- `ALLOWED_CONTENT_TYPES`/`MAX_DOCUMENT_BYTES` (`src/features/documents/schemas.ts`) are unchanged — this feature does not relax or change what's accepted, only how the bytes travel and how upload state is tracked.
- `documentObjectPath`'s shape (`{organizationId}/cases/{caseId}/requirements/{requirementId}/{documentId}`) is unchanged and reused as-is for the reserved path.

---

## 1. Current state (why this is being built)

Today, `uploadRequirementDocument` (`src/application/client-portal.ts`) does everything server-side inside one Server Action call: validate the grant/requirement, generate a `documentId`, call `createSignedUploadUrl`, call `uploadToSignedUrl` (which internally does a `PUT` via the global `fetch()` — verified in `node_modules/@supabase/storage-js/src/lib/common/fetch.ts`, `storage-js@2.110.8`: `put()` is a thin wrapper calling `fetcher(url, {method:'PUT', ...})` with no progress hook of any kind), then `registerDocument`. The browser only ever sees one `await` on the whole thing — the file already went browser→Next.js server (as `FormData` in the Server Action's own request), and the server then re-uploads the same bytes server→Storage. Two transfers of the same bytes, and no signal to the browser at any point in between. This is what "freezes" on a slow connection or a large file.

`fetch()`'s inability to report upload progress is not a version-specific quirk: the Fetch API specification has no standardized, cross-browser mechanism for observing bytes-sent-so-far on a request body as it streams to the server. `XMLHttpRequest.upload.onprogress` (paired with `xhr.abort()` for real cancellation) remains the standard mechanism for this — confirmed by inspecting the actual SDK code above, not assumed from its age.

## 2. Architecture

```
prepareUploadAction (Server Action)
  → validates grant/permission/requirement, exactly as uploadRequirementDocument does today
  → reserves a document_upload_sessions row FIRST (status: 'pending'), THEN mints the signed
    upload URL — if minting fails after the row exists, that row is marked 'cancelled'/deleted;
    never the reverse order, which would leave a valid upload credential with no internal record
  → returns { sessionId, path, signedUrl, token } to the browser

Direct browser → Supabase Storage upload
  → XMLHttpRequest PUT to the signed URL, replicating uploadToSignedUrl's exact wire request
    (same method, same FormData shape: cacheControl + the file appended under key '') — verified
    by reading the SDK's own implementation, not reimplemented from a guess
  → xhr.upload.onprogress drives a real percentage; xhr.abort() is real cancellation
  → the signed token defaults to upsert: false when minted with no options (confirmed empirically
    below, §5) — a second write to the same path with the same or a different token is refused by
    Storage with a 409, never a silent overwrite

finalizeUploadAction (Server Action) + finalize_document_upload (Postgres RPC)
  → see §4 for the full claim/finalize state machine
```

## 3. Schema: `document_upload_sessions`

```sql
create table public.document_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null,
  requirement_id uuid not null,
  participant_id uuid not null,
  bucket text not null default 'case-documents',
  storage_path text not null unique,
  original_file_name text not null,
  declared_content_type text not null,
  declared_size_bytes bigint not null,
  -- Recorded at prepare time as now() + 2 hours — the empirically-confirmed default TTL of the
  -- signed upload URL itself (verified against this project's local Storage stack: a minted
  -- token's decoded iat/exp differ by exactly 7200 seconds). Not read by any code path yet — its
  -- only purpose is observability: distinguishing "our own upload_session_expired (30-minute
  -- window)" from "the signed URL token itself would also have expired by now" when diagnosing a
  -- stuck upload. Today those two causes always collapse to the same recovery action (prepare
  -- again), but this makes them distinguishable in the data without needing to decode a token.
  signed_url_expires_at timestamptz not null,
  -- The eventual documents.id. Chosen here, before any documents row exists — so it cannot carry
  -- a foreign key yet. This is a reservation, not a reference.
  reserved_document_id uuid not null,
  -- Filled only by finalize_document_upload, on success. By construction always equal to
  -- reserved_document_id when non-null — the check constraint below makes that an enforced
  -- invariant, not just a convention.
  completed_document_id uuid references public.documents (id),
  check (completed_document_id is null or completed_document_id = reserved_document_id),
  status text not null default 'pending'
    check (status in ('pending', 'finalizing', 'completed', 'cancelled', 'expired')),
  claimed_at timestamptz,        -- set when status becomes 'finalizing'; the lease start
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,   -- created_at + 30 minutes
  completed_at timestamptz
);

create index document_upload_sessions_cleanup_idx
  on public.document_upload_sessions (status, expires_at)
  where status in ('pending', 'finalizing');
```

RLS: a Participant may `select`/`insert` their own sessions (scoped by `participant_id in (select app.granted_participant_ids('upload'))`, mirroring `requirements`' own grant-scoped policy shape). No `update`/`delete` policy for any client role — every state transition happens through the RPCs below (`security invoker`, relying on the same RLS for the authorization read, then `FOR UPDATE`).

**Retention:** `cancelled`/`expired` rows are never deleted immediately — only the underlying Storage object is deleted right away. The row stays for 7–30 days (diagnosability, and so a late retry reads a real "this session ended, here's why" state instead of "session not found"). A second, separate cleanup pass purges rows in a terminal state older than the retention window.

## 4. The claim/finalize state machine (closes the finalize/cancel/cleanup race)

The risk: `finalize` must call out to Storage (`storage.info(path)`, a real network round-trip) before it can safely write `documents`. If `cancel` or the cleanup cron can act on the same session while that call is in flight, the object or the session record could be deleted or reused out from under `finalize`. The fix is an explicit `finalizing` state with a time-boxed lease — cancel and cleanup are structurally forbidden from touching a session in that state while its lease is live.

**Lease duration: 5 minutes, justified, not a magic number.** The lease must comfortably exceed the worst-case wall-clock time of `storage.info()` (a single small HTTP call — empirically near-instantaneous against this project's Storage backend) plus `finalize_document_upload`'s own execution (a handful of single-row reads/writes under a lock already held). Five minutes is a wide, deliberately generous margin over that real cost — not tuned to any specific measured latency, and not the initial, unexamined 90 seconds. A future change to this number should re-state the same justification (worst-case Storage round-trip + RPC execution, with margin), not just pick a new figure.

**Why no separate lease token/nonce is needed — traced against the exact race described during design review.** Consider: caller A claims at t=0 (`finalizing`, `claimed_at=0`); `storage.info()` takes unusually long, say 80s; the cleanup pass runs at t=91s (past a hypothetical short lease) and reclaims the session to `pending`; caller B claims at t=92s, finishes quickly, and completes the session (`status='completed'`) at t=93s; caller A's own `finalize_document_upload` call finally executes at t=95s. Does caller A's stale call corrupt anything? No: `finalize_document_upload` re-reads the session's *current* status under its own `FOR UPDATE` lock at the moment it runs — it does not trust that the caller who claimed it is still the rightful owner. At t=95s it sees `status = 'completed'` (set by caller B) and its own guard (`if status is not 'finalizing' then raise 'upload_session_not_finalizing'`) rejects the stale attempt outright. The worst outcome of a very late, reclaimed-out-from-under-it `finalize` call is wasted work (an unnecessary `storage.info()` call and a rejected RPC) — never a duplicate `documents` row, never corrupted state. This is a property of checking *live* status at the moment of the lock, not of any timing assumption — it holds regardless of how the 5-minute lease value is chosen. A lease token/nonce would add nothing beyond what this check already guarantees, so it's deliberately left out of the MVP; revisit only if a future change makes `finalize_document_upload`'s guard check something less strict than the row's current status.

### `claim_upload_session_for_finalize(p_session_id uuid)` — RPC, first call `finalizeUploadAction` makes

```sql
-- Authorization: plain non-locking SELECT (participant owns this session), then FOR UPDATE.
-- status = 'completed'   -> return completed_document_id immediately. No Storage call, ever, for
--                            a retry of an already-finished session — this is deliberately the
--                            FIRST branch checked, before anything else runs.
-- status = 'finalizing'
--   claimed_at within lease (5 minutes) -> raise 'upload_finalize_in_progress'
--   claimed_at outside lease (stale)     -> reclaim: proceed as if 'pending'
-- status = 'pending' (or just reclaimed) and not expired
--                         -> status := 'finalizing', claimed_at := now(); return alreadyCompleted=false
-- status = 'cancelled'    -> raise 'upload_session_cancelled'
-- status = 'expired'      -> raise 'upload_session_expired'
```

Only one caller can ever win the `pending`/stale-`finalizing` → `finalizing` transition, because the row lock serializes every concurrent claim attempt — no separate lease token/nonce is needed: whichever caller's transaction commits first sets `claimed_at` to a fresh timestamp, and any other concurrent caller that then acquires the lock sees a `finalizing` row whose lease is (by definition) not yet stale, and is correctly turned away with `upload_finalize_in_progress` rather than reclaiming it.

### `finalizeUploadAction`, in full

```
1. claim_upload_session_for_finalize(sessionId)
   - if alreadyCompleted -> return { documentId: completed_document_id }, done. No Storage call.
2. storage.info(path)  -- external system, outside any Postgres transaction. Safe: the session is
   'finalizing', so cancel/cleanup cannot act on it while this call is in flight.
   - verify: object exists; size > 0; size equals declared_size_bytes exactly (Storage reports the
     real transferred size, so this is a real check, not a re-statement of client input);
     content_type as stored by Storage equals declared_content_type — this is a metadata
     consistency check against what was declared at prepare time, not a proof of the file's actual
     content (see §6).
3. finalize_document_upload(p_session_id, p_verified_size_bytes, p_verified_content_type) -- RPC
   - authorization SELECT, then FOR UPDATE on the session row
   - if status is not 'finalizing' (e.g. it somehow reverted — defensive) -> raise
     'upload_session_not_finalizing'
   - re-validate: requirement not already 'satisfied', grant still active with 'upload' permission,
     Case still 'open' -- these can have changed during the upload's wall-clock duration
   - insert into public.documents (id, organization_id, case_id, requirement_id, storage_path,
     file_name, content_type, size_bytes, uploaded_by_auth_user_id) values (
       (select reserved_document_id from ...), ..., p_verified_size_bytes, p_verified_content_type, ...)
     -- replicates registerDocument's insert + audit_events shape directly in SQL, since this must
     -- run inside the same transaction as the session's own state change; registerDocument (TS)
     -- is untouched and keeps serving whatever else calls it today
   - insert into audit_events (...)
   - update session set status = 'completed', completed_at = now(),
       completed_document_id = reserved_document_id
   - return reserved_document_id
```

### `cancel_upload_session(p_session_id uuid)` — RPC

```sql
-- status = 'finalizing' -> raise 'upload_finalize_in_progress'. Cancel can never touch a session
--                           mid-finalize; the lease resolves on its own (completes, or goes stale
--                           and becomes reclaimable by a future finalize attempt or by cleanup).
-- status = 'completed'   -> raise 'upload_already_completed'
-- status = 'pending'     -> status := 'cancelled'
-- status in ('cancelled','expired') -> no-op, idempotent
```

`cancelUploadSessionAction` calls this RPC, then — only if it returned success for a genuine `pending → cancelled` transition — best-effort deletes the Storage object (outside the transaction, same principle as finalize's Storage call; a delete failure here is logged, not surfaced as an error, since the cleanup cron is the real backstop for orphaned objects).

### Cleanup (cron, mirroring this project's existing `pg_cron` reminder pattern)

Three separate, independently-runnable steps — not one combined pass — so that a failure in the external Storage-deletion step (step C) can never prevent the two purely-internal Postgres steps (A, B) from keeping the session table's state correct:

**A. `app.reclaim_stale_finalizing_sessions()`** — SQL function, `pg_cron`, every few minutes: `finalizing` rows with `claimed_at` older than the 5-minute lease → `pending` (if `expires_at` hasn't passed) or directly `expired` (if it has). Never touches a `finalizing` row within its live lease. Runs independently of B and C.

**B. `app.expire_stale_pending_sessions()`** — SQL function, `pg_cron`, same cadence: `pending` rows with `expires_at` in the past → `expired`. Independent of A and C — a `pending` session can expire on its own schedule regardless of whether any `finalizing` reclaim happened this pass.

**C. Storage cleanup** — the actual object deletion, an external HTTP call (same shape as the existing `send-reminders` Edge Function that already does external calls on a cron trigger in this codebase), reading every `expired`/`cancelled` row whose Storage object hasn't been confirmed deleted yet and deleting it. Runs on its own schedule; a transient failure here leaves an orphaned object for the *next* run to retry — it never blocks A or B, and A/B having already moved a row to `expired`/`cancelled` is what makes it discoverable to C in the first place.

## 5. Signed upload URL reuse — verified empirically, not assumed

Tested directly against this project's local Supabase stack (not inferred from documentation, which can drift from the deployed version): `createSignedUploadUrl(path)` called with no options — exactly how this codebase calls it today — embeds `"upsert":false` in the returned token. A first `uploadToSignedUrl` PUT with real content succeeded; a second PUT to the same path with the same token and *different* content was rejected outright with `409 The resource already exists`, and a follow-up `.info()` call confirmed the object's `version`/`etag`/`lastModified` were completely unchanged by the second attempt. The race the design initially worried about — `finalize` inspects object A, then the client reuses the token to silently swap in object B before the `documents` row commits — is therefore not merely unlikely but structurally prevented by Storage's own `upsert:false` enforcement, provided this design never opts into `upsert: true` anywhere (a hard constraint on prepare's `createSignedUploadUrl` call, stated explicitly so a future edit doesn't reintroduce the race).

## 6. Content-type/size validation — scope, stated precisely

`finalize`'s comparison of Storage's stored `content_type`/`size` against `declared_content_type`/`declared_size_bytes` is a **metadata consistency check**: it confirms the object that actually landed matches what `prepare` was told to expect, and that its size is exactly what got transferred (a real signal — Storage reports the real byte count, this isn't restating client input). It is **not** proof of the file's real content — a `content_type` is request metadata, not a property Storage authenticates against the bytes. The actual content-type barrier remains what already exists: `ALLOWED_CONTENT_TYPES`'s allow-list (checked at `prepare`, unchanged), the file extension the client declares, and `Content-Disposition: attachment` on read URLs (already supported via `createDocumentDownloadUrl`'s existing `download` option — no change needed here). Magic-byte inspection, antivirus scanning, and sandboxed rendering are explicitly out of scope for this feature — named here as deliberate future hardening, not an oversight.

**Checksum: out of scope, and here is why precisely.** TLS already protects the transport against corruption in transit. A checksum is only meaningful if it can be computed on the real local file, obtained or recomputed for the stored object, and compared during `finalize` — and `storage.info()` does not expose a content hash usable for that comparison here. Adding a checksum the client declares, which the server cannot independently verify against anything, would prove nothing while adding client-side hashing cost (large files via `SubtleCrypto`) for no real guarantee. Revisit only if Storage's metadata surface changes to expose a verifiable digest.

## 7. UI (contract, not final pixels)

`RequirementCard`'s upload button gains: a determinate progress bar (`xhr.upload.onprogress` → percentage) once a `prepareUploadAction` call succeeds and the browser starts the direct PUT; a "Cancelar" affordance that calls `xhr.abort()` and, in parallel, `cancelUploadSessionAction(sessionId)`; on `finalize` returning `upload_finalize_in_progress`, a short automatic retry (the lease is 5 minutes, so a legitimate in-flight finalize resolves quickly relative to that) rather than surfacing an error; on `upload_session_expired`/`upload_session_cancelled`, a message prompting the user to pick the file again (a fresh `prepareUploadAction` call — never a blind retry against a dead session).

## 8. Testing plan

- **Isolation (RPCs, real DB):** `claim_upload_session_for_finalize` — completed short-circuits without touching anything else; pending claims correctly; finalizing-within-lease is refused; finalizing-past-lease is reclaimed; cancelled/expired are refused with the right codes. `finalize_document_upload` — happy path creates exactly one `documents` row with the *verified* (not declared) size/content-type; re-validates requirement/grant/Case state at finalize time (a Case closed mid-upload is refused); idempotent on a second call once completed; **the exact stale-claim race from design review**: claim, force the row to `pending` directly (simulating a reclaim), have a second flow complete the session, then call `finalize_document_upload` with the first (now-stale) claim's context and assert it's rejected with `upload_session_not_finalizing`, not a duplicate `documents` row. `cancel_upload_session` — refuses mid-finalize; succeeds only from `pending`; idempotent from a terminal state. `reclaim_stale_finalizing_sessions`/`expire_stale_pending_sessions` — each independently testable, including a test proving a failure/no-op in the (separately-tested) Storage-deletion step never prevents these two from running or from being tested in isolation from it.
- **Concurrency:** two simultaneous `finalize` calls on the same session — exactly one performs the Storage inspection and insert; the other gets `upload_finalize_in_progress` or the completed short-circuit, never a duplicate `documents` row (mirrors this project's own established concurrency-test rigor from the Case Stages workflow feature — deterministic setup, real assertions on row counts, not a "some assertion passes" test).
- **Security:** a Participant cannot claim/finalize/cancel another participant's session; the reserved path can't be redirected to a different Case/requirement (finalize takes only `sessionId`, never a path); the `upsert:false` empirical finding is captured as a permanent regression test (create a session, upload real bytes, attempt a second PUT with the same token and different bytes, assert `409` and that `.info()` is unchanged).
- **Compatibility:** confirms nothing else that reads `documents`/calls `registerDocument` today is affected — this feature only changes the Portal's own upload entry point.
