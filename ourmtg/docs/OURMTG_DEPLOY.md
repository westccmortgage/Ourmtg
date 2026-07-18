# OurMTG — Deploy Runbook

From "code pushed" to "working in production", in order. Repeatable — every step is
idempotent or safely re-runnable.

## 0. Repository / Netlify wiring (one-time, already done)

- Repo: `westccmortgage/Ourmtg`, branch `main`. App lives in the `ourmtg/` subdirectory.
- The **repo-root `netlify.toml`** sets `base = "ourmtg"` — Netlify builds inside the
  subdirectory, publishes `ourmtg/dist`, serves functions from `ourmtg/netlify/functions`.
- Do NOT set Base/Build/Publish in the Netlify UI — leave them blank so the committed
  `netlify.toml` is the single source of truth.

## 1. Database (Supabase — SAME project as GRCRM)

Open the SQL editor for the shared project and run, in order:

1. `supabase/migrations/036_ourmtg_portal.sql`
2. `supabase/migrations/037_portal_invites.sql`
3. `supabase/migrations/038_ourmtg_team_and_requests.sql`
4. `supabase/migrations/039_site_settings.sql`

All are idempotent — safe to re-run. Verify:

```sql
-- 11 loan_/portal_ tables across 036–038 (site_settings, added by 039, is named
-- differently and is checked separately below).
select count(*) from information_schema.tables
 where table_schema='public' and (table_name like 'loan_%' or table_name like 'portal_%');
-- expect 11 (loan_files/documents/conditions/messages/strategy + portal_users/access/
--            invites/consent/access_log/team)

select count(*) from information_schema.tables
 where table_schema='public' and table_name='site_settings';   -- expect 1 (migration 039)
select id, public from storage.buckets where id='ourmtg-docs';  -- must be: false

-- cron_heartbeat: written by the projector's heartbeat() but NOT created by 036–039.
-- The write is fail-soft, so its absence won't break the cron — but the "LO dashboard
-- empty" troubleshooting below relies on it. Verify it exists; if it does NOT, apply the
-- non-runnable draft docs/phase0/draft-migrations/042_cron_heartbeat.DRAFT.sql (guard removed).
select count(*) from information_schema.tables
 where table_schema='public' and table_name='cron_heartbeat';  -- expect 1 (create if 0)
```

## 2. Netlify environment variables

Site → Configuration → Environment variables. `VITE_*` vars are **build-time** — set
them BEFORE deploying; changing them requires a redeploy.

| Var | Value | Notes |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co` | public |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_…` (or legacy anon JWT) | public |
| `VITE_COMPANY_NAME` / `VITE_NMLS_COMPANY` / `VITE_NMLS_LO` / `VITE_LO_NAME` | branding + compliance footer | public |
| `SUPABASE_URL` | same project URL | server |
| `SUPABASE_ANON_KEY` | same publishable/anon key | server (JWT verification) |
| `SUPABASE_SERVICE_ROLE` | `sb_secret_…` (or legacy service_role JWT) | **SECRET — server only** |
| `OURMTG_URL` | `https://ourmtg.com` | link base in emails/invites |
| `LEAD_INBOUND_URL` | GRCRM webhook URL | server (lead-submit proxy) |
| `LEAD_INBOUND_TOKEN` | GRCRM lead_sources token | **SECRET — server only** |
| `RESEND_PLATFORM_KEY` | Resend API key | optional; emails fail-soft without it |
| `OURMTG_ADMIN_EMAILS` | comma-separated admin emails | **required to edit site settings** (Phase 1A Blocker A); empty = no one can |
| `OURMTG_CRON_SECRET` | long random string | **SECRET — the sole cron authorization** (Phase 1A Blocker B); scheduler sends `Authorization: Bearer <secret>` |
| `OURMTG_FINGERPRINT_SALT` | random per-deploy string | optional; salts the lead-submit rate-limit fingerprint (no raw IP stored) |
| `LEAD_RATE_MAX` / `LEAD_RATE_WINDOW_MS` | numbers | optional lead-submit rate-limit tunables (default 5 / 60000) |

> **Cron note (Phase 1A Blocker B):** the projector authorizes **only** on a verified
> `OURMTG_CRON_SECRET` presented as `Authorization: Bearer <secret>` (constant-time; never in
> the query string; never logged). Netlify's `x-netlify-event` header is diagnostic context
> only and never authorizes. Trigger `sync-loan-file` from an authenticated scheduler (e.g. a
> GitHub Actions cron or uptime pinger) that sends the Bearer header — otherwise it 403s.
> If `OURMTG_CRON_SECRET` is unset, the projector fail-closes (403 every run).

Then: **Deploys → Trigger deploy → Clear cache and deploy site.**

## 3. Supabase Auth (magic link)

- Authentication → Providers → Email: enabled (magic link, no passwords).
- Authentication → URL Configuration:
  - Site URL: `https://ourmtg.com`
  - Redirect URLs: `https://ourmtg.com/**` (plus `https://www.ourmtg.com/**` and the
    `*.netlify.app/**` preview host if used).

## 4. Custom domain

- Netlify → Domain management → add `ourmtg.com`, set as primary, Force HTTPS on.
- Keep `OURMTG_URL` in sync with the primary domain.

## 5. Verification checklist

| Check | Expected |
|---|---|
| `https://ourmtg.com/` | OurMTG home (two buttons), not "Page not found" |
| `/.netlify/functions/portal-status` | `{"ok":false,"error":"Unauthorized"}` (401) — proves env + functions OK. `Service not configured` (503) = missing SUPABASE_* env. 404 = functions not deployed |
| `/login` → email → magic link → return | signed in; errors here = Supabase Redirect URLs not set |
| Sign in with the GRCRM owner email | LO dashboard renders; empty list until the projector syncs deals (runs every 5 min once deployed) |
| Invite a borrower from a loan file | invite email arrives (needs RESEND_PLATFORM_KEY); accepting on the borrower's email opens the borrower dashboard |
| `/apply` submit | lead lands in GRCRM (needs LEAD_INBOUND_URL/TOKEN); consent rows appear in `portal_consent` |

## Troubleshooting

- **Site loads but sign-in dead** → `VITE_*` vars weren't in the build; redeploy with cache clear.
- **401 everywhere after sign-in** → `SUPABASE_ANON_KEY` (server) missing/mismatched with the client key.
- **LO dashboard empty forever** → migrations not applied, or projector not running
  (check Netlify → Functions → sync-loan-file logs; `cron_heartbeat` table row updates).
- **Emails never arrive** → `RESEND_PLATFORM_KEY` unset (fail-soft, silent by design).
