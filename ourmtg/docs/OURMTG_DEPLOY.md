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

All are idempotent — safe to re-run. Verify:

```sql
select count(*) from information_schema.tables
 where table_schema='public' and (table_name like 'loan_%' or table_name like 'portal_%');
-- expect 11 (10 portal/loan tables + portal_team)
select id, public from storage.buckets where id='ourmtg-docs';   -- must be: false
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
| `CRON_SECRET` | random string | optional; manual cron trigger |

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
