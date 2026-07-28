# Invitar miembro por correo + establecer/recuperar contraseña

## Context

`src/app/members/members-directory.tsx` ships an "Invitar miembro" control that renders
**disabled** with a "Próximamente" tooltip and no backing behavior at all — deferred in an earlier
plan (`docs/superpowers/plans/2026-07-27-staff-nav-pages.md`, Task 5) until real SMTP existed.
SMTP is now live (Resend, verified domain `avanza.work`). This spec makes the invite real.

Building it surfaces a second, previously-invisible gap: DocuFlow's staff sign-in is email +
password (`src/app/login/page.tsx`), but **no page exists anywhere in the app for setting a
password** — not for accepting an invite, not for recovering a forgotten one. Both the invite
email's link and a "forgot password" link land nowhere without one. This spec builds the minimal
shared page both flows need, plus the "forgot password" request page.

**Product naming:** the domain `avanza.work` is hosting infrastructure only. `PRODUCT.md` still
reads "Working name: **DocuFlow**," and no rename has been decided — a full DocuFlow→AVANZA
rebrand was discussed and explicitly deferred to its own, separate spec. Everything in this
document uses "DocuFlow," matching the current, still-accurate product name. When the rebrand
spec lands, the two new email templates this spec adds will need the same pass every other
DocuFlow-branded surface gets — that's an expected consequence of the future rename, not a new
open item for this spec to track.

**Revision note:** this spec went through one review round. The original version had a real
ordering bug (Auth identity creation before the operation that could still fail), an audit-log
attribution bug (crediting the invited person instead of the inviting owner), an implicit
assumption about how `/set-password` receives its session, and several smaller gaps. This version
incorporates the fixes; the corrected design is presented directly below rather than as a diff
against the first draft.

Existing conventions this follows: the `src/application/*.ts` use-case layer with the
`ok`/`fail`/`UseCaseError` contract (`src/application/errors.ts`), thin Server Actions
(`src/app/*/actions.ts`), `logDomainEvent` for domain events (`'member.added'` already exists in
`AuditAction`, `src/features/audit/record.ts` — no new action needed), and the admin-client
discipline in `src/lib/supabase/admin.ts`: admin is used only for the one operation that genuinely
requires it, never for anything a caller-supplied value could turn into a tenant leak. The
`unique (organization_id, user_id)` constraint on `members`
(`supabase/migrations/20260722193136_organizations_and_members.sql:45`) already exists — this spec
relies on it as the real backstop against a concurrent double-invite, not just the pre-check query.

## Invitar miembro (`inviteMember`)

**Use case** — `src/application/invite-member.ts`, `inviteMember(client, admin, input, sendEmail =
sendTransactionalEmail)`. The fourth parameter exists purely for testability (see Testing below) —
production call sites never pass it, relying on the default. Matches
`updateOrganization`'s final shape: no separate `actor` parameter — the *inviting* caller's
identity is derived inside the use case via `client.auth.getUser()`, the same verified-session
anchor, never a value the caller could misstate. Naming inside the function is deliberately
unambiguous throughout — `actorUser` (the authenticated owner making the call) is never the same
variable as `invitedAuthUser` (the identity being resolved or created for the invitee) — because
conflating the two was exactly the bug the first draft of this spec had in its audit-logging step.

```ts
export interface InviteMemberInput {
  readonly organizationId: string;
  readonly email: string;
}
```

Corrected flow:

```
inviteMember
├─ Resolve actorUser via client.auth.getUser()
├─ Verify actorUser is owner of organizationId, through the RLS-scoped client
├─ Normalize and validate email (trim, lowercase, basic shape)
├─ Resolve invitedAuthUser via admin.auth.admin.listUsers (exact normalized-email match)
│
├─ Identity already existed
│   ├─ Check existing membership (organization_id, invitedAuthUser.id) — conflict if found
│   ├─ Insert membership through the RLS-scoped client
│   ├─ Log member.added, actor = actorUser, target = the new members row
│   └─ Send a DocuFlow membership-notification email directly via Resend (best-effort, last —
│       a slow external call must never delay the domain event it's describing)
│
└─ Identity newly created
    ├─ admin.auth.admin.inviteUserByEmail(normalizedEmail, { redirectTo: `${APP_ORIGIN}/set-password` })
    ├─ Insert membership through the RLS-scoped client
    │   └─ On failure: delete the auth user THIS CALL just created (compensating action —
    │       never delete a pre-existing identity), then rethrow the original failure
    └─ Log member.added, actor = actorUser, target = the new members row
```

Steps in detail:

1. **Authorize.** `const { data: { user: actorUser } } = await client.auth.getUser()`; throw
   `UseCaseError('unauthenticated', ...)` if null. Then check `members` for `(organization_id,
   user_id) = (organizationId, actorUser.id)` with `role = 'owner'`, through the caller's own
   RLS-scoped `client` — identical pattern to `updateOrganization`. Throws
   `UseCaseError('forbidden', ...)` if not an owner, before anything else runs.

2. **Normalize and validate the email.** `const normalizedEmail =
   input.email.trim().toLowerCase()`, then a basic shape check (reuse a simple Zod
   `z.string().email()` via `parseInput`, matching every other use case's validation boundary —
   don't hand-roll a regex when the codebase already has one validation entry point). This
   happens inside the use case itself, not only via `<input type="email">` — the use case must
   hold regardless of how it's called.

3. **Resolve the identity.** Paginated `admin.auth.admin.listUsers({ page, perPage: 200 })`, up to
   25 pages — the exact bound already used in `tests/helpers/fixtures.ts`'s
   `findAuthUserIdByEmail` and `scripts/seed-demo.mjs`'s `findUserByEmail`; this spec moves that
   pattern into product code as a small local helper in `invite-member.ts` (not exported — this
   file is the only caller). Match is exact and normalized on both sides:
   `user.email?.toLowerCase() === normalizedEmail` — never a partial/substring match. If the admin
   API itself errors (not "not found" — an actual request failure), that's an unexpected error,
   thrown as-is, not swallowed.

4a. **Existing identity branch.** Query `members` for `(organization_id, user_id) =
    (organizationId, invitedAuthUser.id)`. If a row exists, throw
    `UseCaseError('conflict', 'Esta persona ya es miembro de tu organización.')`. Otherwise insert
    the membership (`role: 'staff'`) through the RLS-scoped `client` — `members_insert_by_owner`
    already permits this for an owner, and using `client` (not `admin`) here means RLS proves the
    write is authorized independently of step 1's own check, the same defense-in-depth reasoning
    already established for `updateOrganization`. The pre-check query is a fast, friendly rejection;
    the real guarantee against a concurrent double-invite is the DB's own `unique (organization_id,
    user_id)` constraint — catch a unique-violation (Postgres `23505`) on the insert and map it to
    the identical `UseCaseError('conflict', ...)` as a backstop, not a second code path with
    different copy.

    Log the domain event (step 5 below) immediately after the insert succeeds — before sending
    anything. Only then send the DocuFlow-branded notification (see "Existing-identity
    notification" below) — **best-effort**, last in the sequence: wrap in try/catch, log a failure
    to the server console, never let a notification failure fail the membership itself (same
    principle `logDomainEvent` already follows for audit events — the row is the source of truth,
    not the email — but the row's own event record should never wait on an external HTTP call
    either).

4b. **New identity branch.** `admin.auth.admin.inviteUserByEmail(normalizedEmail, { redirectTo:
    \`${APP_ORIGIN}/set-password\` })` — creates the `auth.users` row and sends Supabase's own
    invite email in one call. Then insert the membership exactly as in 4a (through the RLS-scoped
    client, same conflict handling — though structurally, a brand-new identity cannot already be a
    member of anything, so the pre-check query is not reachable here; keep only the unique-violation
    catch as the real guard). **If the membership insert fails for any reason** (constraint
    violation from something unforeseen, RLS mismatch, connection failure, the organization itself
    having been deleted mid-request): delete the `auth.users` row this call just created —
    `admin.auth.admin.deleteUser(invitedAuthUser.id)` — before rethrowing the *original* insert
    error. The cleanup call is itself wrapped in its own try/catch: if `deleteUser` also fails,
    that failure is logged (never printed with the original error's stack, just noted as its own
    line) and the **original insert error is what gets thrown either way** — a cleanup failure must
    never replace or mask the real failure that triggered it. This compensation only ever runs when
    this call is certain it created the identity in step 4b; the existing-identity branch (4a)
    never deletes anything, under any circumstance. This is the closest thing to a two-phase
    operation available without a dedicated `member_invitations` table (a real, more robust future
    design — explicitly out of scope for this MVP, see below).

    One accepted limitation of this approach, worth stating rather than discovering later:
    Supabase's invite email may already have been sent (step 4b's `inviteUserByEmail` call) before
    the membership insert fails and the compensating delete runs. If the invited person clicks that
    email after the identity has been deleted, they land on an "invalid link" state — a real but
    narrow race window, and an accepted MVP tradeoff given the alternative is the
    `member_invitations` table already deferred above.

5. **Log the event** (both branches). `logDomainEvent(client, { organizationId, action:
   'member.added', targetType: 'member', targetId: <the new members row's id>, actor: { kind:
   'member', authUserId: actorUser.id }, metadata: { invitedEmail: normalizedEmail,
   invitedAuthUserId: invitedAuthUser.id, identityAlreadyExisted: <true|false> } })`. The actor is
   always the inviting owner — never the invited person — and the invited identity appears only as
   `targetId`/metadata, never as `actor`.

`organizationId` is a parameter, but — same as every other use case in this codebase — it is never
accepted as client input; the Server Action supplies it from `getStaffContext()`. `admin` (the
service-role client) is used only for `listUsers`/`inviteUserByEmail`/the compensating
`deleteUser`, never for the `members` read/write, matching the discipline in
`src/lib/supabase/admin.ts`'s own docstring.

**Server Action** — new file `src/app/members/actions.ts`, `inviteMemberAction(email: string)`:
same three-layer shape as `updateOrganizationAction` — resolves `getStaffContext()`, fast-rejects a
non-owner with a dedicated `forbidden` result before calling the use case (the use case
re-verifies independently regardless, per its own `client.auth.getUser()` check), then calls
`inviteMember(supabase, createAdminClient(), { organizationId: staff.organizationId, email })` —
production call sites never pass the fourth (`sendEmail`) parameter, letting it default. Returns
`ActionResult<null>`. `revalidatePath("/members")` on success.

**UI** — `src/app/members/members-directory.tsx`: the disabled button becomes a real one. Clicking
opens a small modal (single email field, `type="email"`, `required`), single primary CTA ("Enviar
invitación"), a text-only "Cancelar" — matching the Client Portal's one-CTA-per-screen convention
already established in this codebase. On success: close the modal and call Next's
`router.refresh()` (from `next/navigation`) so the Server Component re-runs `getOrganizationMembers`
and the new row appears — the same mechanism `src/app/cases/new/page.tsx` already uses after
`createCaseAction`, no new data-fetching path needed. Errors render inline in the modal, keyed on
the returned `reason` (`conflict` → the exact message from step 4a; `forbidden`/`unexpected` →
their own copy) — no generic fallback text.

### Existing-identity notification (new: direct Resend call)

Supabase cannot "invite" an identity that already exists, so an owner adding an existing person
would otherwise surface in the directory with no notice at all — a real product gap the review
round caught (this identity could be a client who once verified via the Client Portal's OTP flow
and has never set a password, or staff at a different organization; either way, they don't know
they now have access here). This spec adds a small, direct call to Resend's API — not through
Supabase Auth's mailer, which only handles Supabase-native auth emails (invite/recovery/magic
link) — for this one case.

`src/lib/email/resend.ts` (new, tiny):
```ts
const RESEND_API_KEY = required('RESEND_API_KEY'); // same required() helper as src/lib/supabase/env.ts

export async function sendTransactionalEmail(input: {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
}): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // Resend's HTTP API rejects requests with no User-Agent (403, error 1010) — its own SDK
      // sets this automatically, a manual fetch has to do it explicitly. Rename to avanza/1.0
      // whenever the product rebrand lands; this string is never user-visible.
      'User-Agent': 'docuflow/1.0',
      ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: 'DocuFlow <noreply@avanza.work>',
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });
  if (!response.ok) {
    // Parsed only for Resend's own error `name`/`message` fields — never the raw response body,
    // which could otherwise carry recipient/content details into logs.
    const body = await response.json().catch(() => null);
    throw new Error(`Resend API error: ${response.status} ${body?.name ?? body?.message ?? 'unknown_error'}`);
  }
}
```
`RESEND_API_KEY` is a new server-only env var (the same key already generated for SMTP — Resend
API keys work both ways). `inviteMember`'s step 4a calls this with:
```
Subject: Te agregaron al equipo de {organizationName} en DocuFlow
Body: Ya tienes acceso. Entra en {APP_ORIGIN}/login con tu correo.
      Si todavía no tienes contraseña, usa "¿Olvidaste tu contraseña?" para crear una.
idempotencyKey: `member-added/${organizationId}/${insertedMember.id}`
```
Wrapped in try/catch inside the use case per step 4a above — a failure here is logged server-side
via a structured, minimal line (`{ organizationId, memberId: insertedMember.id, status:
'email_delivery_failed' }` — never the API key, the HTML body, or the full recipient/provider
response) and never surfaces to the owner as a failed invite (the membership already exists and is
real; only the notice about it may be missing).

## Establecer / recuperar contraseña

**`/set-password`** (new) — `src/app/set-password/page.tsx` + a client form with **explicit
states**, not an assumption that a session is already present on mount:

```
Validando enlace   — initial state, shown while resolving
Enlace válido       — form is shown, ready for input
Enlace vencido o inválido — no session ever resolved; form is not rendered
Contraseña guardada — success, briefly shown before redirect
```

On mount, the component listens for `supabase.auth.onAuthStateChange`, watching for
`INITIAL_SESSION`, `SIGNED_IN`, and `PASSWORD_RECOVERY` (the invite link resolves as a normal
`SIGNED_IN`; the recovery link fires Supabase's dedicated `PASSWORD_RECOVERY` event — both are
documented outcomes of Supabase processing the URL, not something this page infers itself) *and*
calls `supabase.auth.getUser()` once immediately, in case a session already resolved before the
listener attached. The component stays in "Validando enlace" until **one of two conclusive
signals** arrives — a real authenticated user (→ "Enlace válido"), or an explicit
auth/session error surfaced by either the listener or `getUser()` (→ "Enlace vencido o
inválido") — and only falls back to a conservative timeout (a few seconds) as a **last-resort
safety net**, not the primary way this decision gets made; a slow hydration or slow connection
should never be misread as an invalid link just because a fixed clock ran out first. The effect
cleans up on unmount (`clearTimeout` + `subscription.unsubscribe()`) and guards against setting
state after unmount. The password form renders only once "Enlace válido" is reached.

**Any authenticated session may use this page, not only one that arrived via an invite/recovery
link.** `supabase.auth.updateUser({ password })` only requires *some* valid session — this route
does not (and, per the review that shaped this spec, deliberately does not try to) distinguish "I
have a session because I clicked a recovery link" from "I have a session because I'm already
logged in and navigated here directly." Both end up doing the same authenticated action
(`updateUser`) either way. Restricting the page to only `PASSWORD_RECOVERY`-originated sessions
would require a signal the invite flow doesn't reliably provide (it resolves as an ordinary
`SIGNED_IN`, indistinguishable from a normal login), so this spec accepts the wider behavior rather
than adding scope to narrow it. Recorded here as an explicit, accepted product decision, not an
overlooked edge case.

The form itself: "Nueva contraseña" (`type="password"`), "Confirmar contraseña", one submit
("Guardar contraseña"). Client-side, before calling Supabase at all: both fields must match, and
length must be at least `MIN_PASSWORD_LENGTH` (see below) — a mismatch or short password shows an
inline error without ever touching the network. Submit is disabled while a request is in flight
(no double-submit). On `supabase.auth.updateUser({ password })` success: show "Contraseña
guardada" briefly, then redirect to `/cases` (the same landing spot `login/page.tsx` already uses
after sign-in). On failure: inline error from Supabase's own message, no redirect, no state
regression back to "Validando enlace."

**Password length** — `src/features/auth/password.ts` (new, tiny):
```ts
export const MIN_PASSWORD_LENGTH = 8;
```
A single exported constant, not a magic number duplicated in JSX, error copy, and tests. Used for
the `minLength` attribute, the client-side match/length check described above, and the Supabase
project's own minimum-password-length setting is expected to already be ≥ 8 (this spec does not
change Supabase's server-side policy — only the client-side pre-check uses this constant, so
Supabase's own rejection is still the real enforcement if the two ever drift).

**`/forgot-password`** (new) — `src/app/forgot-password/page.tsx`, a client component matching
`login/page.tsx`'s visual shape. One field (email), one button ("Enviar enlace"), disabled while a
request is in flight. Normalizes the email (`trim().toLowerCase()`) before calling
`supabase.auth.resetPasswordForEmail(normalizedEmail, { redirectTo:
\`${window.location.origin}/set-password\` })` — `window.location.origin`, not an env var: this
runs in the browser, which already knows its own correct origin in every environment.

Supabase's `resetPasswordForEmail` itself never reveals whether the address exists (that
non-enumeration property is Supabase's own, not something this spec adds) — so the success path
always shows "Si existe una cuenta con este correo, recibirás un enlace para restablecer tu
contraseña." regardless of whether the account is real. That is different from an actual
*operational* failure (network error, Supabase misconfiguration, rate limit): those are real
errors the call can return, and they get their own distinct inline message ("No pudimos procesar
tu solicitud. Inténtalo de nuevo en unos minutos.") rather than being folded into the same neutral
success text — conflating the two would mean a genuinely broken request silently tells the person
to go check an email that was never going to arrive, with no way to know to retry.

**`/login`** — one small addition: a text-only "¿Olvidaste tu contraseña?" link below the form,
`<Link href="/forgot-password">`, styled as a secondary text action (not a button), consistent with
the "one primary CTA per screen" rule already followed elsewhere.

**`APP_ORIGIN`.** Only `inviteMember`'s server-side `inviteUserByEmail` call and the notification
email's login link need this as an env var (`resetPasswordForEmail` runs in the browser and uses
`window.location.origin` instead — no env var needed there). Per `docs/DEPLOYMENT.md`,
`APP_ORIGIN` was already an intentionally-pending environment variable ("needs a domain first") —
that domain now exists (`avanza.work`). Add `APP_ORIGIN` as a real, server-only env var
(`https://avanza.work` in production, `http://localhost:3000` locally), read through a
`required('APP_ORIGIN')`-style helper matching the existing pattern in `src/lib/supabase/env.ts`.

**Production configuration required (manual — not something this code change can do for you):**
1. Add `https://avanza.work/set-password` to Supabase Auth's allowed Redirect URLs
   (Authentication → URL Configuration), or both `inviteUserByEmail` and
   `resetPasswordForEmail`'s `redirectTo` are silently rejected in favor of the default Site URL.
2. Set `APP_ORIGIN=https://avanza.work` and `RESEND_API_KEY=<the same Resend key already
   generated for SMTP>` in the Vercel project's Production environment variables.
3. Apply Spanish copy to Supabase's Invite and Recovery email templates in the dashboard,
   mirroring the Magic Link template work already done. This spec adds the template *files* to the
   repo (`supabase/templates/invite.html`, `supabase/templates/recovery.html`) and the
   corresponding `config.toml` entries for local dev parity; applying them to the production
   dashboard is a manual step the user performs themselves, same as the Magic Link template.

## Email copy (Spanish, "DocuFlow" branding — see the naming note above)

`supabase/templates/invite.html` — a plain link, not a code (unlike Magic Link — this is a
one-time account-setup action, not a per-session credential, so a clickable link is the right
shape here):
```html
<h2>Te invitaron a DocuFlow</h2>
<p>Alguien de tu organización te agregó como miembro. Usa el siguiente enlace para crear tu
contraseña y entrar:</p>
<p><a href="{{ .ConfirmationURL }}">Crear mi contraseña</a></p>
<p>Si no esperabas esta invitación, puedes ignorar este mensaje.</p>
```

`supabase/templates/recovery.html`:
```html
<h2>Recupera tu contraseña</h2>
<p>Usa el siguiente enlace para elegir una nueva contraseña:</p>
<p><a href="{{ .ConfirmationURL }}">Elegir nueva contraseña</a></p>
<p>Si no solicitaste esto, puedes ignorar este mensaje — tu contraseña actual sigue funcionando.</p>
```

## Testing

- `tests/integration/invite-member.test.ts`:
  - An owner can invite a brand-new email; a `members` row is created with `role: 'staff'`, and
    exactly one `member.added` audit event is logged **attributed to the owner** (`actor_auth_user_id
    = ` the owner's id, not the invited person's) — this is the specific regression the review
    round's audit-attribution finding exists to prevent.
  - Inviting an email that already has an `auth.users` identity (built via `createTestUser`) adds
    them as a member without calling `inviteUserByEmail` again — assert on the resulting `members`
    row and on the audit event's metadata (`identityAlreadyExisted: true`). The test environment has
    no fake for Resend's HTTP API, so `inviteMember` takes the notification sender as an optional,
    injectable parameter defaulting to the real `sendTransactionalEmail`:
    `inviteMember(client, admin, input, sendEmail = sendTransactionalEmail)`. This test passes a
    stub (`async () => {}` plus a call-recording flag) and asserts it was invoked once with the
    right `to`/`subject`, without making a real network call. This is the same shape of seam the
    codebase already uses for testability elsewhere (e.g. `tests/helpers/mailbox.ts` intercepts real
    Mailpit delivery for the Client Portal's OTP tests instead of stubbing Supabase's mailer) —
    injecting the function is simpler here since there is no local mail-capture equivalent for a
    direct Resend call.
  - **Compensating deletion**: if the membership insert fails after a *new* identity was created
    (simulate by invoking the use case against a since-deleted/foreign `organizationId` so the
    insert's RLS check fails), the newly-created `auth.users` row no longer exists afterward —
    assert via the admin client. A parallel test confirms the *existing*-identity path never
    deletes anything, even on a simulated insert failure.
  - Inviting an email already a member of the same org is refused with `UseCaseError('conflict',
    ...)`; the `members` table gains no duplicate row.
  - Email normalization: inviting `"  SomeOne@Example.TEST "` resolves/matches the same identity as
    one created with `someone@example.test`.
  - A non-owner staff member's attempt is refused by the use case's own check
    (`UseCaseError('forbidden', ...)`), and separately at the RLS floor directly (bypassing the use
    case), mirroring `update-organization.test.ts`'s two-layer proof.
  - The use case never uses the `admin` client for the `members` insert (a structural assertion —
    e.g. pass a `client` whose `.from('members')` is instrumented/spied, or simply confirm via a
    non-owner-authenticated `client` that the insert still respects RLS end to end, proving `admin`
    wasn't used to bypass it).
  - `organizationId` is always sourced from the resolved staff context, never client input — same
    property, same style of assertion, as the Clientes/Miembros/Configuración work.

- `/set-password` and `/forgot-password`: **this codebase has no component-testing
  infrastructure today** (`vitest.config.ts` runs `environment: 'node'` against a real Postgres,
  with no jsdom/`@testing-library/react` setup anywhere) — adding real interaction tests for these
  two pages means standing up that infrastructure first, which this spec treats as out of scope
  (see below), not something to quietly skip without saying so. What *is* testable with the
  existing Node-environment Vitest setup, and therefore required:
  - `MIN_PASSWORD_LENGTH` and a small extracted `passwordsAreValid(password, confirmation):
    boolean` helper (in `src/features/auth/password.ts`) get plain unit tests — no DOM needed.
  - Email normalization for `/forgot-password` reuses the same normalization the use case test
    above already covers if factored into a shared tiny helper; if the two pages end up with their
    own separate inline `.trim().toLowerCase()`, that's an acceptable, tiny duplication rather than
    a premature shared module (YAGNI) — implementer's call, not a spec requirement either way.
  - Everything else specific to these two pages (session-state transitions, redirect-after-success,
    double-submit prevention, the distinct neutral-vs-error messaging) is manual verification only,
    same as every other page-level task in the prior staff-nav-pages plan.

## Out of scope (explicitly deferred)

- A dedicated `member_invitations` table modeling pending/accepted/expired as a first-class
  lifecycle (mirroring the Client Portal's `invitation_status`). The compensating-delete approach
  above is this MVP's answer to the lack of a true two-phase operation between Supabase Auth and
  Postgres; a real invitations table would be the more robust long-term design, but is a schema
  change out of scope here.
- Resending an invite to someone already a pending/existing member (the conflict check refuses
  this outright; a dedicated "resend" action is a separate, future feature).
- Removing a member or changing an existing member's role.
- **Explicit semantic note, not a deferred feature:** membership authorization becomes active
  immediately once the `members` row is inserted — for both branches, regardless of whether the
  invited person has ever opened the email or set a password. "Accepting" an invitation (setting a
  password) is not itself a domain state transition in this design; it only gives the person a way
  to authenticate into access they already have. If a person somehow obtains a session by another
  means before ever touching the invite email, they can already act as a member. This mirrors the
  same tradeoff already accepted for the `members` table's existing shape (no pending/active state
  today) and is not something this spec changes — a richer lifecycle is the `member_invitations`
  future work noted above.
- Rate-limiting invites beyond whatever Supabase's own Auth rate limits already provide.
- The DocuFlow → AVANZA rebrand (confirmed as a real, upcoming decision, explicitly tracked as its
  own separate spec, not folded into this one).
