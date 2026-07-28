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
shared page both flows need, plus the "forgot password" request page, since leaving the invite
half-built (an email that goes nowhere) would be worse than not building it.

Existing conventions this follows: the `src/application/*.ts` use-case layer with the
`ok`/`fail`/`UseCaseError` contract (`src/application/errors.ts`), thin Server Actions
(`src/app/*/actions.ts`), `logDomainEvent` for domain events (`'member.added'` already exists in
`AuditAction`, `src/features/audit/record.ts` — no new action needed), and the admin-client
discipline in `src/lib/supabase/admin.ts`: admin is used only for the one operation that genuinely
requires it, never for anything a caller-supplied value could turn into a tenant leak.

## Invitar miembro (`inviteMember`)

**Use case** — `src/application/invite-member.ts`, `inviteMember(client, admin, input)`. Matches
`updateOrganization`'s final shape (no separate `actor` parameter — the caller's identity is
derived inside the use case via `client.auth.getUser()`, the same verified-session anchor, not a
value the caller could misstate):

```ts
export interface InviteMemberInput {
  readonly organizationId: string;
  readonly email: string;
}
```

Steps, in order:

1. **Authorize.** Identical pattern to `updateOrganization`: resolve the real caller via
   `client.auth.getUser()`, then check `members` for `(organization_id, user_id) = (organizationId,
   user.id)` with `role = 'owner'`, through the caller's own RLS-scoped `client` — never trusting
   anything the caller already believes about their own role. Throws `UseCaseError('forbidden', ...)`
   if not an owner, before touching anything else.

2. **Resolve the identity.** Paginated `admin.auth.admin.listUsers` lookup by email — the same
   `findAuthUserIdByEmail` pattern already used in `tests/helpers/fixtures.ts` and
   `scripts/seed-demo.mjs`, moved into product code as a small local helper in this file (not
   exported; this is the only caller).
   - **Not found:** `admin.auth.admin.inviteUserByEmail(email, { redirectTo:
     '<APP_ORIGIN>/set-password' })`. This both creates the `auth.users` row and sends Supabase's
     invite email in one call.
   - **Found:** reuse that `user.id`. No email is sent — the person already has an account and can
     already sign in; this reuse is what surfaces them into this organization, not a notification
     event of its own (per the explicit product decision this spec is built against — see the
     approved design conversation, not repeated here as a separate open question).

3. **Refuse a duplicate membership.** Query `members` for `(organization_id, user_id)` — if a row
   already exists, throw `UseCaseError('conflict', 'Esta persona ya es miembro de tu
   organización.')`. This is the only place idempotency is enforced; re-inviting the same email to
   the same org is a conflict, not a silent resend.

4. **Insert the membership.** `client.from('members').insert({ organization_id: organizationId,
   user_id, role: 'staff' })` — through the caller's own RLS-scoped client. `members_insert_by_owner`
   already permits this for an owner; using `client` here (not `admin`) means RLS proves the write
   is authorized independently of step 1, the same defense-in-depth reasoning already established
   for `updateOrganization`.

5. **Log the event.** `logDomainEvent(client, { organizationId, action: 'member.added', targetType:
   'member', targetId: <new members.id>, actor: { kind: 'member', authUserId: user.id }, metadata: {
   invitedEmail: email } })`.

`organizationId` is a parameter, but — same as every other use case in this codebase — it is never
accepted as client input; the Server Action supplies it from `getStaffContext()`. `admin` (the
service-role client) is created fresh per call via `createAdminClient()`, used only for step 2's
`listUsers`/`inviteUserByEmail`, never for the `members` read/write.

**Server Action** — new file `src/app/members/actions.ts`, `inviteMemberAction(email: string)`:
same three-layer shape as `updateOrganizationAction` — resolves `getStaffContext()`, fast-rejects a
non-owner with a dedicated `forbidden` result before calling the use case (the use case re-verifies
independently regardless, per its own `client.auth.getUser()` check), then calls
`inviteMember(supabase, createAdminClient(), { organizationId: staff.organizationId, email })`.
Returns `ActionResult<null>`. `revalidatePath("/members")` on success.

**UI** — `src/app/members/members-directory.tsx`: the disabled button becomes a real one. Clicking
opens a small modal (single email field, `type="email"`, `required`), single primary CTA ("Enviar
invitación"), a text-only "Cancelar" — matching the Client Portal's one-CTA-per-screen convention
already established in this codebase. On success: close the modal and call Next's `router.refresh()`
(from `next/navigation`) so the Server Component re-runs `getOrganizationMembers` and the new row
appears — the same mechanism `src/app/cases/new/page.tsx` already uses after `createCaseAction`, no
new data-fetching path needed. Errors render inline in the modal, keyed on the returned `reason`
(`conflict` → the exact message from step 3; `forbidden`/`unexpected` → their own copy) — no
generic fallback text.

## Establecer / recuperar contraseña

**`/set-password`** (new) — `src/app/set-password/page.tsx` + a small client form. Serves two
entry points that behave identically once the visitor arrives:
- Clicking the invite email's link (from `inviteUserByEmail`'s `redirectTo`).
- Clicking a "forgot password" recovery email's link (from `resetPasswordForEmail`'s `redirectTo`,
  see below).

In both cases, Supabase's client-side auth helper (`@supabase/ssr`'s browser client, already used
elsewhere — see `src/lib/supabase/client.ts`) picks up the session Supabase establishes from the
URL fragment on page load; the page does not need to parse tokens itself. The form: one field
("Nueva contraseña", `type="password"`, minimum length matching Supabase Auth's own password
policy — no separate validation to duplicate), one confirmation field, one submit button
("Guardar contraseña"). On submit: `supabase.auth.updateUser({ password })`. On success: redirect
to `/cases` (the same landing spot `login/page.tsx` already uses after sign-in). On failure: inline
error, no redirect.

**`/forgot-password`** (new) — `src/app/forgot-password/page.tsx`, a client component matching
`login/page.tsx`'s visual shape (same `Shell`-less centered card layout, same brand header). One
field (email), one button ("Enviar enlace"). Calls `supabase.auth.resetPasswordForEmail(email, {
redirectTo: `${window.location.origin}/set-password` })` — `window.location.origin` here, not an
env var: this call runs in the browser, so the browser already knows its own correct origin in
every environment (localhost in dev, `avanza.work` in production) with nothing to configure or get
out of sync. Always shows the same success message regardless of whether the email exists ("Si el
correo existe, te enviamos un enlace.") — this is a deliberate non-enumeration property (matching
this codebase's existing principle, e.g. the Case Access invitation flow never reveals whether a
token/email is valid), not an oversight to "fix" into a more informative message later.

**`/login`** — one small addition: a text-only "¿Olvidaste tu contraseña?" link below the form,
`<Link href="/forgot-password">`, styled as a secondary text action (not a button), consistent with
the "one primary CTA per screen" rule already followed elsewhere.

**`APP_ORIGIN`.** Only `inviteMember`'s server-side `inviteUserByEmail` call needs this as an env
var (`resetPasswordForEmail` runs in the browser and uses `window.location.origin` instead, per
above — no env var needed there). Per `docs/DEPLOYMENT.md`, `APP_ORIGIN` was already an
intentionally-pending environment variable ("needs a domain first") — that domain now exists
(`avanza.work`). Add `APP_ORIGIN` as a real, server-only env var (`https://avanza.work` in
production, `http://localhost:3000` locally), read through a `required('APP_ORIGIN')`-style helper
matching the existing pattern in `src/lib/supabase/env.ts` (a bare `required(name)` function that
throws if the variable is missing) — add it there or alongside it, not a new ad hoc `process.env`
read in `invite-member.ts`.

**Production configuration required (manual, same class as prior SMTP/template steps — not
something this code change can do for you):**
1. Add `https://avanza.work/set-password` to Supabase Auth's allowed Redirect URLs
   (Authentication → URL Configuration), or both `inviteUserByEmail` and
   `resetPasswordForEmail`'s `redirectTo` are silently rejected in favor of the default Site URL.
2. Set `APP_ORIGIN=https://avanza.work` in the Vercel project's Production environment variables.
3. Optionally (approved above): apply Spanish copy to Supabase's Invite and Recovery email
   templates in the dashboard, mirroring the Magic Link template work already done. This spec adds
   the template *files* to the repo (`supabase/templates/invite.html`,
   `supabase/templates/recovery.html`) and the corresponding `config.toml` entries for local dev
   parity; applying them to the production dashboard is a manual step the user performs themselves,
   same as the Magic Link template.

## Email copy (Spanish, matching the Magic Link template's voice)

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
    exactly one `member.added` audit event is logged.
  - Inviting an email that already has an `auth.users` identity (simulate via
    `createTestUser`/`grantVerifiedAccess`-style fixture reuse) adds them as a member without
    attempting `inviteUserByEmail` again — assert on the resulting `members` row, not on whether an
    email was "sent" (no mailbox assertion needed here, unlike `invitation-flow.test.ts`, since
    this path deliberately sends nothing).
  - Inviting an email already a member of the same org is refused with `UseCaseError('conflict',
    ...)`; the `members` table gains no duplicate row.
  - A non-owner staff member's attempt is refused by the use case's own check
    (`UseCaseError('forbidden', ...)`), and separately at the RLS floor directly (bypassing the use
    case), mirroring `update-organization.test.ts`'s two-layer proof.
  - `organizationId` is always sourced from the resolved staff context, never client input — same
    property, same style of assertion, as the Clientes/Miembros/Configuración work.
- No automated test for `/set-password` or `/forgot-password` — these are thin client components
  wrapping two direct Supabase Auth SDK calls (`updateUser`, `resetPasswordForEmail`) that are
  themselves outside this codebase's control to test meaningfully without a real email round-trip;
  manual verification only, same as every other page-level task in the prior plan.

## Out of scope (explicitly deferred)

- Resending an invite to someone already a pending/existing member (the conflict check refuses
  this outright; a dedicated "resend" action is a separate, future feature).
- Removing a member or changing an existing member's role.
- Any UI indication of "invited, not yet accepted" vs. "active" — `members` carries no such state
  today (unlike the Client Portal's `invitation_status` lifecycle), and adding one is a schema
  change out of scope for this spec.
- Rate-limiting invites beyond whatever Supabase's own Auth rate limits already provide.
