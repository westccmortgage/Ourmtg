# OurMTG — Engineering Handoff (current)

Supersedes the earlier "backend-only, repo broken" handoff report. That report was
accurate for its moment; this one reflects the repository as it exists on `main` now.

## Status summary

| Area | State |
|---|---|
| Backend gateway (13 Netlify functions) | ✅ Complete for MVP+ scope, syntax-checked (`npm run check`) |
| Frontend (Vite + React SPA, `src/`) | ✅ Built: public front door, borrower app, realtor portal, LO dashboard + file detail |
| Repo structure / Netlify config | ✅ Fixed: root `netlify.toml` with `base = "ourmtg"` (monorepo pattern — do not "flatten" as the old report suggested; no longer needed) |
| DB migrations (036, 037, 038) | ⚠️ Written + idempotent; **must be applied manually** in the Supabase SQL editor (shared GRCRM project) |
| Netlify env vars | ⚠️ Supabase URL + publishable key + service role entered by owner; verify the full table in `OURMTG_DEPLOY.md` §2 and redeploy with cache clear |
| End-to-end test with real data | ❌ Not yet run — treat every flow as "verified by code review", not "known good in prod" |
| Stray branch `claude/ourmtg-repo-f7weyz` in the `crm` repo | ❌ Still needs manual deletion (out of this repo's session scope) |

## What exists (by layer)

- **Migrations** — `036` core schema (9 tables, RLS, private `ourmtg-docs` bucket),
  `037` invites, `038` team access + escrow/title roles + custom doc requests support.
- **Functions** — projector (`sync-loan-file`, 5-min cron), lead proxy (`lead-submit`,
  also writes the `portal_consent` ledger), portal gateway (`portal-*`: invites, status,
  checklist, uploads, review, pre-approval, review queue, file detail, doc request,
  conditions, messages, team management).
- **Frontend** — 12 pages; role auto-detected from `portal_access` grants (RLS-readable)
  + review-queue ownership/team membership. Realtor/third-party status ALWAYS goes
  through `portal-status` (column-scoped) — never a direct `loan_files` read.

## Load-bearing design rules (do not break)

1. **GRCRM is the source of truth.** OurMTG reads `app_state` (`wcci-deals`) read-only
   via the projector. NEVER write borrower data into `app_state`.
2. **Realtors/escrow/title are structurally blocked** from documents, conditions, and
   amounts — in RLS *and* in every endpoint (`canSeeFinancials`). Preserve both layers.
3. **Financial docs live only in the private `ourmtg-docs` bucket**, via server-minted
   signed URLs. `crm-media` (public) is never used.
4. **Pre-approval is human-set only** (`portal-preapproval-set`); the projector
   deliberately never touches `preapproval_*`.
5. **Secrets never reach the browser**: no `VITE_` var may hold the service role or the
   lead webhook token (that's why `lead-submit` exists).

## Known gaps / deferred (see OURMTG_ROADMAP.md)

- SMS (Twilio) — designed in spec §L, not built; all notifications are email-only.
- WCCI strategy integration — schema placeholder only (`loan_strategy`).
- Automation rules (24h/72h doc reminders) — live in GRCRM's `cron-automations`, not wired.
- No automated tests / CI; no rate limiting on `lead-submit`; `_lib` is duplicated from
  GRCRM by design (self-contained repo) — fixes don't auto-propagate.
- Legal pages are placeholder copy pending counsel review.
