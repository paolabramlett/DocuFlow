# DocuFlow — Deployment State

Snapshot of where the hosted deployment stands, what is intentionally pending, and how to resume. Written 2026-07-23.

## TL;DR

The **backend schema is live in production** (Supabase, us-east-1) and secure. The **Edge Function is deployed but inert** (fails closed until secrets are loaded). Nothing else is configured yet, on purpose — the remaining pieces (auth config, secrets, SMTP) are only needed once there is a UI and a real client to test with. The deployment is stable and costs nothing to leave as-is.

## Projects

| Project | Ref | Region | Status | Notes |
|---|---|---|---|---|
| **DocuFlow (production)** | `wfkommwpsjohrxiivhfa` | us-east-1 | ACTIVE | The real one. Linked locally. |
| DocuFlow (old, to delete) | `rkinssbcajgttmzohmnj` | us-west-2 | ACTIVE | Created in the wrong region, empty, never pushed to. Safe to delete (Settings → General → Delete project). In a **different Supabase account**. |

**CLI account note:** the production project lives in a Supabase account that is *not* the machine's original CLI login. To run any `supabase` command against it, first `npx supabase login` into that account (browser flow). Switching the CLI login affects other local projects (`we-one`, `reloj-checador-dev`) that use the previous account — log back in afterward if needed.

**Local `npx`:** the interactive shell does not have node/npx on PATH (nvm isn't loaded). Prefix commands with the PATH export, or use the absolute path:
```bash
export PATH="/Users/paolabramlett/.nvm/versions/node/v24.16.0/bin:$PATH"
```

## What is deployed and verified

- **Schema** — all 22 migrations applied (`supabase migration list` shows 22/22 remote). 15 tables, all empty.
- **Row Level Security** — verified against the hosted REST API: every table returns `[]` to an anonymous (anon-key) client, and `create_organization` without auth returns `403 authentication required`. Same isolation the 208 local tests validate.
- **Edge Function `send-reminders`** — deployed and hardened. Verified against the live URL:
  - No JWT → `401` (platform gate; not publicly invocable).
  - Anon JWT, no secrets → `503 not configured` (fails closed; sends nothing).
  - It requires an internal `x-trigger-secret` header on top of the JWT once configured.

## What is intentionally pending

None of this blocks anything today. All of it is needed only when a UI and a real client flow exist.

### 1. Edge Function secrets (load when sending the first real reminder)
Set in Dashboard → Edge Functions → send-reminders → Secrets, or `supabase secrets set`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform automatically.

| Secret | What it is |
|---|---|
| `RESEND_API_KEY` | Resend API key |
| `REMINDER_FROM_ADDRESS` | e.g. `no-reply@<verified-domain>` |
| `APP_ORIGIN` | The app's origin (needs a domain first) |
| `REMINDER_TRIGGER_SECRET` | A strong random string; the cron presents it in `x-trigger-secret` |

The function fails closed until all four are present.

### 2. Auth configuration (set in Dashboard, NOT via `config push`)
`supabase config push` is **not safe here** — `config.toml` is tuned for local dev (localhost `site_url`, `email_sent = 3600` inflated for tests) and would clobber production redirect URLs and the mail rate limit. Set these three by hand instead (the security decisions from `design.md`):

| Setting | Value | Dashboard location |
|---|---|---|
| Magic Link email → send a **code** | contents of `supabase/templates/magic_link.html` (`{{ .Token }}`) | Authentication → Email Templates |
| Invite email | contents of `supabase/templates/invite.html` | Authentication → Email Templates |
| Recovery email | contents of `supabase/templates/recovery.html` | Authentication → Email Templates |
| OTP expiry | 300 s (5 min) | Authentication → Providers → Email |
| Session | inactivity 1h, timebox 24h | Authentication → Sessions |
| **Site URL** | `https://<production-domain>` | Authentication → URL Configuration |

**Site URL is load-bearing for invite/recovery, not just cosmetic.** Both the invite and
recovery email templates build their link from `{{ .SiteURL }}/auth/confirm?...` directly — there
is no per-request `redirectTo` override anymore (see `src/app/auth/confirm/route.ts`). If Site URL
isn't set to the real production domain, every invite and password-reset email silently points at
the wrong host and the feature is broken end to end with no visible error. The `additional_redirect_urls`
allowlist setting is NOT used by this flow (that only ever gated the older, now-removed
`{{ .ConfirmationURL }}`-based links) and does not need to be touched for this feature to work.

The invite-member feature also needs two ordinary app env vars set in Vercel (Project Settings →
Environment Variables), separate from the Edge Function secrets above: `APP_ORIGIN` (the deployed
app's real origin) and `RESEND_API_KEY` (the same Resend key used for the reminder Edge Function).
`src/lib/supabase/env.ts` reads both eagerly at module load, so a missing value fails every server
request, not just the invite path — set them before the first deploy that includes this feature,
not after.

### 3. SMTP (for real email delivery)
Supabase's built-in email only sends to team addresses and is heavily rate-limited. Configure custom SMTP (via Resend) before any real client OTP or reminder can be delivered.

### 4. pg_cron drain trigger
The queue cron (`docuflow-queue-reminders`, every 15 min) is deployed and only *queues* due reminders. Triggering the Edge Function that *sends* them is a separate step, deliberately not baked into a cron command carrying a service-role key. Wire it (e.g., pg_cron + pg_net calling the function URL with the trigger secret) when secrets are loaded. Verify pg_cron is enabled in Dashboard → Database → Extensions.

### 5. OTP end-to-end smoke test
Blocked until SMTP + the code template are set. The flow is already tested locally end-to-end with real email delivery (Mailpit) in `invitation-flow.test.ts`. Do the hosted smoke test with a team email or a staging project — do **not** create test users/data on production.

## How to resume the deploy

```bash
export PATH="/Users/paolabramlett/.nvm/versions/node/v24.16.0/bin:$PATH"
npx supabase login                         # into the DocuFlow account
npx supabase link --project-ref wfkommwpsjohrxiivhfa
npx supabase migration list                # confirm remote state
# future schema changes:
npx supabase db push
# redeploy the function after edits:
npx supabase functions deploy send-reminders
```

## Local development (unchanged)

Local Supabase runs on remapped ports (**544xx**, not the default 543xx) because another Supabase project (`web`) occupies 54322 on this machine. Studio: http://127.0.0.1:54423.

```bash
npm run db:start     # start local stack
npm run db:env       # write .env.local from the running stack
npm run db:reset     # apply all migrations fresh
npm run db:types     # regenerate src/types/database.ts
npm test             # 208 tests
npm run typecheck
npm run lint
```

## Next step

Not more deploy config — the **UI**. The backend is done, secure, and in production. Secrets and auth config get loaded naturally when the UI reaches the first real send/login. See the design collaboration plan (discussed separately) for how UI is being built without Figma.
