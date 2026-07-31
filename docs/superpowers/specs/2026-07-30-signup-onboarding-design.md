# Sign Up + Onboarding — Design

## Context

Avanza (formerly DocuFlow) has no self-service registration path. The only way an Organization
and its first Owner come into existence is the `create_organization` Postgres RPC, invoked today
exclusively from `scripts/seed-demo.mjs` and test helpers — never from the running application.
`PRODUCT.md` currently frames organization onboarding as controlled/manual, not open registration;
this spec deliberately changes that stance for the first time.

This spec adds a public `/signup` page and an authenticated `/onboarding` completion step, so
anyone with a valid email can create their own Organization and become its Owner without anyone
running a script on their behalf.

**Explicitly out of scope, deferred to future specs:**
- CAPTCHA/Turnstile or any bot-detection beyond a simple per-email cooldown.
- Per-IP rate limiting (would need an external store — Redis/Vercel KV — beyond this project's
  current Postgres-only infrastructure; revisit if real abuse appears).
- A UI for an already-onboarded user to create an *additional* Organization (the generic
  `create_organization` RPC already supports this, per `PRODUCT.md`'s "one identity, many
  organizations" model — this spec only wires up the *first* organization, via a separate,
  dedicated RPC that does not constrain that future capability).
- Any change to the invite flow (`inviteUserByEmail`), which remains entirely separate.

## Key product decision (new)

**An authenticated identity can legitimately exist without belonging to any Organization yet.**
Until now, the implicit model was `authenticated → staff-of-some-org` as one inseparable step.
This spec introduces a real, persistent middle state:

```
not authenticated → (onboarding: authenticated, no organization) → staff of an organization
```

This is not a transient error condition to paper over — it is a normal state a real account can
sit in indefinitely (e.g., someone who verifies their email and abandons before finishing). Every
future feature that touches identity/membership (invitations, switching organizations, accepting
an invite before or after completing onboarding) must account for this state existing.

### Known limitation, deliberately deferred: Portal Client sessions and the staff guard

`resolveStaffRedirect`/`requireStaff` cannot distinguish "authenticated, no organization yet
because onboarding is incomplete" from "authenticated, no organization, because this is a Portal
Client session" — a real Supabase session created by the Client Portal's own OTP flow
(`src/features/case-access/invitations.ts`'s `signInWithOtp`/`verifyOtp`), which never inserts a
`members` row. Both states look identical to `getStaffContext()`: a session with no membership.
Concretely, a Portal Client who hits a staff-gated page (by mistake, or by following a stale
bookmark) is now routed to `/onboarding` instead of `/login`.

This is not a new hole RLS-wise — a Client could already self-serve a brand-new Organization via
`/signup` with any email today, regardless of this routing decision — but it is a real, silent
posture change worth naming rather than leaving implicit. The correct fix is not one more
conditional bolted onto `resolveStaffRedirect`: it is a genuine classification of authenticated-
identity kinds (staff vs. Portal Client vs. onboarding-in-progress), which is a separable piece of
work with its own design tradeoffs. This spec deliberately does not attempt that here. Until that
design exists, `resolveStaffRedirect` routes every session-without-membership to `/onboarding`,
and any future change to that behavior must be made with this limitation in mind, not treated as
an isolated bug fix.

## Architecture overview

```
/signup (email only)
  → signUpAction: atomic cooldown claim → supabase.auth.signUp() with a random, never-shown password
    → confirmation.html email → /auth/confirm (new "signup" OTP type) → session established
      → /onboarding (guarded: authenticated + no organization)
        → completeOnboardingAction: real password (+ confirmation) → complete_onboarding RPC
          → returns ActionResult; the client redirects on success (see section 3)
```

Three new pages/actions, two new RPCs, one new table, one existing-function fix, and one
existing-function safety upgrade (`requireStaff`). Nothing about `create_organization`,
`invite-member`, or the Client Portal's OTP flow changes.

## 1. Schema

**Migration** `supabase/migrations/20260730120000_signup_onboarding.sql`:

```sql
-- Cooldown-only anti-abuse for public signup. NOT anti-bot or anti-abuse protection on its own —
-- no per-IP limiting, no CAPTCHA, no pattern detection. Sufficient for MVP; expand if real abuse
-- appears. RLS enabled with zero policies: reachable only via the admin (service_role) client
-- inside signUpAction/claim_signup_attempt, never directly by anon/authenticated.
--
-- Retention: this is temporary operational state, not a historical record of signup attempts —
-- rows older than 7 days carry no ongoing purpose and should be purged periodically (a scheduled
-- job/cron script, out of scope for this spec to build, but the intent is documented here so it
-- doesn't quietly become an indefinite log of every email address that ever tried to sign up):
--   delete from public.signup_attempts where last_attempted_at < now() - interval '7 days';
create table public.signup_attempts (
  email text primary key,
  last_attempted_at timestamptz not null default now()
);
alter table public.signup_attempts enable row level security;

-- Atomic claim: the earlier select-then-upsert approach was a genuine TOCTOU race (two concurrent
-- requests could both read "cooldown expired" before either writes). This makes the read-decide-
-- write one atomic operation via the UPSERT's own WHERE clause — only one concurrent caller for
-- the same email can ever see `claimed = true`.
create or replace function public.claim_signup_attempt(
  signup_email text,
  cooldown_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean;
begin
  -- Defensive validation: security definer, so it must not trust its own caller's parameters
  -- blindly even though only service_role can invoke it today.
  if nullif(btrim(signup_email), '') is null or length(signup_email) > 320 then
    raise exception 'invalid signup email' using errcode = '22023';
  end if;
  if cooldown_seconds < 1 or cooldown_seconds > 86400 then
    raise exception 'invalid cooldown' using errcode = '22023';
  end if;

  insert into public.signup_attempts (email, last_attempted_at)
  values (signup_email, now())
  on conflict (email) do update
    set last_attempted_at = excluded.last_attempted_at
    where public.signup_attempts.last_attempted_at
      <= now() - make_interval(secs => cooldown_seconds)
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

revoke all on function public.claim_signup_attempt(text, integer) from public;
grant execute on function public.claim_signup_attempt(text, integer) to service_role;

-- Dedicated, idempotent first-onboarding RPC — deliberately NOT a modification of the existing
-- create_organization (which stays the generic, reusable "create an organization" capability with
-- no notion of "first" or "only"). Constraining create_organization itself to one-per-user would
-- silently break PRODUCT.md's "one identity, many organizations" model for any future "create an
-- additional organization" feature. This function owns exactly one concern: "has this identity
-- completed onboarding yet, and if not, do it atomically."
create or replace function public.complete_onboarding(
  organization_name text,
  organization_industry text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_organization_id uuid;
  new_organization_id uuid;
begin
  if current_user_id is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  -- Serializes only concurrent onboarding calls for THIS identity. Does not constrain how many
  -- organizations a user may eventually belong to (members.unique(organization_id, user_id)
  -- stays exactly as-is). Released automatically on commit or rollback.
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));

  -- Multiple membership rows for one user are valid under the multi-organization model — not an
  -- anomaly to guard against. We only need to know whether onboarding already happened, and
  -- return a deterministic answer if so.
  select organization_id
  into existing_organization_id
  from public.members
  where user_id = current_user_id
  order by created_at asc
  limit 1;

  if existing_organization_id is not null then
    return existing_organization_id;
  end if;

  -- Defensive validation: this is security definer, callable by any authenticated user directly.
  -- Zod already validates in the Server Action; these mirror organizations' own CHECK constraints
  -- exactly (name 1-200 chars, industry the same 6-value enum already used by Settings).
  if nullif(btrim(organization_name), '') is null or length(btrim(organization_name)) > 200 then
    raise exception 'invalid organization name' using errcode = '22023';
  end if;
  if organization_industry not in ('notary', 'accounting', 'legal', 'insurance', 'hr', 'other') then
    raise exception 'invalid organization industry' using errcode = '22023';
  end if;

  insert into public.organizations (name, industry)
  values (btrim(organization_name), organization_industry)
  returning id into new_organization_id;

  insert into public.members (organization_id, user_id, role)
  values (new_organization_id, current_user_id, 'owner');

  return new_organization_id;
end;
$$;

revoke all on function public.complete_onboarding(text, text) from public;
grant execute on function public.complete_onboarding(text, text) to authenticated;
```

## 2. `/signup`, `/auth/confirm`, configuration

**`src/app/signup/page.tsx`** (new, client component, same visual pattern as `/login`/
`/forgot-password`): one field (email). On submit, calls `signUpAction(email)`. Always shows the
same neutral message regardless of outcome: *"Si el correo es válido, te enviamos un enlace para
continuar."* Link to `/login` for existing users.

No conflict between client-side validation and the neutral response: a malformed email can be
flagged inline before submit (immediate, helpful feedback); once a syntactically valid email is
actually submitted, the response is always neutral regardless of what happens server-side; and the
server itself stays neutral even against a direct call bypassing the UI entirely (`signUpAction`'s
own `emailSchema.safeParse` failing still returns `ok(null)`, never a distinct error).

**`src/app/signup/actions.ts`:**
```ts
"use server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, type ActionResult } from "@/application/errors";

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const SIGNUP_COOLDOWN_SECONDS = 60;

function isExpectedNeutralSignupError(error: { status?: number }): boolean {
  // Rate-limit-shaped errors from Supabase's own GoTrue-level throttling are an expected outcome
  // under abuse, not a genuine operational failure worth alerting on.
  return error.status === 429;
}

export async function signUpAction(email: string): Promise<ActionResult<null>> {
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) return ok(null); // neutral even on malformed input

  const normalizedEmail = parsed.data;
  const admin = createAdminClient();

  const { data: claimed, error: cooldownError } = await admin.rpc("claim_signup_attempt", {
    signup_email: normalizedEmail,
    cooldown_seconds: SIGNUP_COOLDOWN_SECONDS,
  });
  if (cooldownError || !claimed) return ok(null); // neutral even when cooldown-limited

  // The cooldown is consumed BEFORE calling auth.signUp(), intentionally. If GoTrue then fails
  // transiently, the caller waits out the same cooldown before their next attempt — preferable to
  // releasing the claim and letting repeated failures become a spam vector of their own.
  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password: randomBytes(32).toString("base64url"),
  });

  if (error && !isExpectedNeutralSignupError(error)) {
    // Never the email, password, or token — matches this codebase's existing audit-metadata
    // discipline (src/features/audit/record.ts's FORBIDDEN_METADATA_KEYS).
    console.error("signUp failed", { code: error.code, status: error.status });
  }
  return ok(null);
}
```

**`supabase/templates/confirmation.html`** (new):
```html
<h2>Confirma tu cuenta</h2>
<p>Usa el siguiente enlace para confirmar tu correo y crear tu cuenta en Avanza:</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding">Confirmar mi cuenta</a></p>
```
`type=signup` matches this project's own established convention (`invite.html`/`recovery.html` use
`type=invite`/`type=recovery` — the actual GoTrue mailer action name, not the generic `email`
alias some external Supabase docs show).

**`supabase/config.toml`:**
```toml
[auth.email]
enable_confirmations = true   # was false; nothing else in this codebase calls auth.signUp today

[auth.email.template.confirmation]
subject = "Confirma tu cuenta — Avanza"
content_path = "./supabase/templates/confirmation.html"
```
`enable_confirmations` is a global Auth setting, not scoped to this feature — the invite flow
(`inviteUserByEmail`) itself needs no code change, but this spec's testing section (§5) includes
an explicit regression check that inviting an existing user still works exactly as before under
the new setting, rather than assuming it from reading the code alone.

**`src/app/auth/confirm/route.ts`:**
```ts
const SUPPORTED_OTP_TYPES = ["invite", "recovery", "signup"] as const;
```
Nothing else in that route changes — `verifyOtp`, `next`-path validation, and session cleanup on
failure all already work unchanged.

## 3. `/onboarding` and the abandonment-recovery model

**`getStaffContext()` fix** (`src/features/auth/context.ts`) — a real, pre-existing bug, now
load-bearing: the function never checked the query's `error`, so any database failure already
silently resolved to `null`. That was low-stakes when `null` only ever meant "redirect to
`/login`"; it becomes dangerous once `null` can also mean "redirect to `/onboarding`" — an
unexpected error must never be misread as "no organization yet."
```ts
const { data: membership, error } = await supabase
  .from("members")
  .select("role, organization:organizations(id, name, industry)")
  .eq("user_id", user.id)
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();

if (error) throw new Error(`getStaffContext: ${error.message}`);
if (!membership?.organization) return null;
// ... rest unchanged
```
The added `.order("created_at", { ascending: true })` is a minor, pre-existing-limitation note,
not something this spec resolves: since one identity can hold multiple memberships, a query with
no notion of "active organization" will eventually need to pick one somehow. Ordering by oldest
membership makes that pick stable rather than arbitrary — it does not solve the future "which
organization is this identity currently acting as" problem (an active-organization selector is
out of scope here), it just stops today's behavior from depending on undefined row order.

**`requireStaff()` distinguishes "not authenticated" from "authenticated, no organization":**
```ts
export async function requireStaff(): Promise<StaffContext> {
  const context = await getStaffContext();
  if (context) return context;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect("/onboarding");
  redirect("/login");
}
```

**A symmetric guard for `/onboarding` itself:**
```ts
export async function requireOnboarding(): Promise<{ userId: string; email: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (await getStaffContext()) redirect("/cases");
  return { userId: user.id, email: user.email ?? "" };
}
```

**State matrix these two guards produce together:**

| State | `requireStaff()` | `requireOnboarding()` |
|---|---|---|
| No session | → `/login` | → `/login` |
| Session, no membership | → `/onboarding` | passes through |
| Session, has membership | passes through | → `/cases` |
| Unexpected query error | propagates (error boundary) | propagates (error boundary) |

**`src/app/onboarding/page.tsx`** — form with four fields: contraseña, confirmar contraseña,
nombre de organización, industria. Show/hide applies to both password fields.

**`src/app/onboarding/actions.ts`:**
```ts
"use server";

const completeOnboardingSchema = z.object({
  organizationName: z.string().trim().min(1).max(200),
  organizationIndustry: z.enum(["notary", "accounting", "legal", "insurance", "hr", "other"]),
});

export async function completeOnboardingAction(input: {
  password: string;
  passwordConfirmation: string;
  organizationName: string;
  organizationIndustry: string;
}): Promise<ActionResult<{ organizationId: string }>> {
  await requireOnboarding(); // redirects if not applicable — defense in depth, mirrors the page guard

  if (!passwordsAreValid(input.password, input.passwordConfirmation)) {
    return { ok: false, reason: "validation", message: "Revisa tu contraseña." };
  }
  let parsed;
  try {
    parsed = parseInput(completeOnboardingSchema, {
      organizationName: input.organizationName,
      organizationIndustry: input.organizationIndustry,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, reason: "validation", message: "Revisa los datos de tu organización.", issues: error.issues };
    }
    throw error;
  }

  const supabase = await createClient();

  // Order is load-bearing: password MUST be set before the organization exists. If this were
  // reversed and failed between steps, the account would have an organization but no way to ever
  // learn its password — a lock with no key. This order self-heals instead: if step 2 fails, the
  // user can still log in (their real password is already set) and requireStaff() routes them
  // straight back here to retry, since they still have no organization.
  const { error: passwordError } = await supabase.auth.updateUser({ password: input.password });
  if (passwordError) {
    return { ok: false, reason: "unexpected", message: "No pudimos guardar tu contraseña. Intenta de nuevo." };
  }

  const { data: organizationId, error: orgError } = await supabase.rpc("complete_onboarding", {
    organization_name: parsed.organizationName.trim(),
    organization_industry: parsed.organizationIndustry.trim(),
  });
  // No non-null assertion: "no error but no UUID either" must never be read as success, even
  // though the SQL function's own `returns uuid` makes it look like that combination can't
  // happen — the generated client type is nullable, and this is exactly the kind of anomaly
  // worth surfacing rather than silently trusting.
  if (orgError || !organizationId) {
    return {
      ok: false,
      reason: "unexpected",
      message: "Tu contraseña se guardó, pero no pudimos crear la organización. Intenta nuevamente.",
    };
  }

  return ok({ organizationId });
}
```

**Redirect ownership is explicit and belongs to the client, not the action**: `completeOnboardingAction`
always returns a plain `ActionResult`, never calls `redirect()` itself — mixing `redirect()` (which
throws internally) with a discriminated `ActionResult` return would make partial-failure messages
unreachable. The client component does the navigation:
```ts
const result = await completeOnboardingAction(input);
if (result.ok) {
  router.replace("/cases");
  router.refresh();
} else {
  setError(result.message);
}
```
No state is tracked client- or server-side about "password already set" across retries — resending
the same password on a retry is harmless, and tracking that state deliberately isn't worth it for
this MVP.

## 4. Validation

- **Email** (`/signup`): `z.string().trim().toLowerCase().email().max(320)` — same shape as
  `create-case-with-participants.ts`'s existing email field.
- **Password** (`/onboarding`): reuses `MIN_PASSWORD_LENGTH`/`passwordsAreValid` from
  `src/features/auth/password.ts` unchanged — same minimum, same confirmation-matching logic
  already used by `/set-password`.
- **Organization name**: `z.string().trim().min(1).max(200)` — identical to
  `updateOrganizationSchema`.
- **Industry**: `z.enum(['notary', 'accounting', 'legal', 'insurance', 'hr', 'other'])` — same
  enum, no new values invented.

## 5. Testing

**Unit (no DB):** `isExpectedNeutralSignupError`'s classification logic.

**Integration (real Postgres):**
- `claim_signup_attempt`: first claim for a fresh email succeeds (`true`); a second claim within
  the cooldown window fails (`false`); after the cooldown elapses, a claim succeeds again.
  **Concurrency**: two simultaneous claims for the same email (`Promise.all`) — exactly one
  returns `true`, the other `false`. This is the real proof the TOCTOU race is closed. A cooldown
  of `0`, a negative value, or `86401` → rejected with `errcode = '22023'`.
- `complete_onboarding`: first call creates organization + owner membership; a second call (same
  user) returns the same organization, no duplicate created; **concurrency**: two simultaneous
  calls for the same user (`Promise.all`) — exactly one organization exists afterward (the
  advisory-lock proof, same technique as `save_blueprint`'s `FOR UPDATE` concurrency test); a user
  who already has a membership row → returns the oldest (`order by created_at asc`), creates
  nothing new; a forced failure on the `members` insert (e.g. a constraint violation contrived for
  the test) → the `organizations` insert from the same call is rolled back, no orphaned
  organization remains; invalid organization name/industry passed directly to the RPC (bypassing
  the Server Action) → rejected with the specific `errcode`, proving the defensive validation is
  real, not decorative.
- `getStaffContext()`: authenticated user with no membership → `null`; a simulated query error →
  propagates as a thrown `Error`, never silently becomes `null`.
- `completeOnboardingAction` partial-failure paths: `updateUser` fails → `complete_onboarding` is
  never called, password-specific message returned; `updateUser` succeeds but `complete_onboarding`
  fails → the "tu contraseña se guardó..." message returned, and the user is confirmed to still
  have zero memberships (can retry); both succeed → returns `organizationId`, never via a non-null
  assertion (see §3) — a stubbed "no error, no id" response from the RPC layer must return
  `unexpected`, never `ok`.
- `signUpAction`: a successful claim followed by a simulated `auth.signUp()` failure → the
  cooldown remains claimed (the next attempt within the window is still blocked, matching the
  intentional "consume cooldown before calling GoTrue" ordering documented in §2).
- **Invite-flow regression**: after `enable_confirmations = true`, `inviteUserByEmail` still sends
  `invite.html`, `/auth/confirm?type=invite` still establishes a session and proceeds to
  `/set-password` exactly as before — proving the global Auth setting change doesn't alter the
  existing invite path's behavior.

**Isolation/RLS:**
- `signup_attempts` is unreachable via the anon or authenticated roles — readable/writable only
  through the admin (service_role) client.
- `complete_onboarding` rejects an unauthenticated (anon) caller cleanly.
- The full guard state matrix from section 3's table, exercised end to end: each of the four
  states routes to exactly the page listed, and no combination of `/onboarding` ↔ `/login` ↔
  `/cases` produces a redirect loop.

**Manual verification checklist** (no component-testing infrastructure, same convention as the
Blueprint authoring feature):
- Full happy path: `/signup` → real email via local Mailpit → `/auth/confirm` → `/onboarding` →
  `/cases`.
- Abandon after confirming email but before completing onboarding; sign in later; land back on
  `/onboarding`.
- Complete onboarding, sign out, sign in again with the real chosen password (not the random
  one) — the definitive proof the password-before-organization ordering actually works end to
  end for a real user, not just in the RPC's own test.
- Open two `/onboarding` tabs for the same session and submit both nearly simultaneously; confirm
  both end up pointed at the same organization.
- Reuse an already-consumed confirmation link; confirm it fails safely. Note: `/auth/confirm`'s
  existing failure path redirects to `/set-password` regardless of which flow failed (invite,
  recovery, or now signup) — landing an aborted signup attempt on a page literally named
  "set password" is semantically odd, but this is pre-existing, shared behavior this spec does not
  change. The check here is narrower and already covers the real risk: confirm `/set-password`
  does not loop and does not let the visitor proceed without a real session (it already infers
  validity from "someone is authenticated," and the route's cleanup step clears any stale session
  on failure — verify that still holds). Whether a failed signup confirmation should land
  somewhere more specific (`/login` or a dedicated "invalid link" screen) is a real follow-up, out
  of scope here as long as today's fallback stays safe.
- Attempt to tamper with `next` on `/auth/confirm`'s URL; confirm it never redirects off-site
  (`isSafeNextPath`'s existing allowlist already covers this — this is a regression check, not new
  code).
- Request signup repeatedly during the cooldown window; confirm the UI always shows the same
  neutral message regardless of what's actually happening server-side.
