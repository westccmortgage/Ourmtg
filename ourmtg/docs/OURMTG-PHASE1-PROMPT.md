# OURMTG — Exact Phase 1 Prompt (corrected)

Use this prompt verbatim to start Phase 1. It is written against the **actual** repository (Vite/React + Netlify Functions + Supabase, migrations 036–039), not the previous backend-only fiction. Do not begin Phase 1 until the owner decisions in `OURMTG-PHASE0-SUMMARY.md` §7 are answered (at minimum #2/R1).

---

## PROMPT

```
OURMTG PHASE 1 — HARDEN THE EXISTING APPLICATION (no new domain tables)

CONTEXT (verified, not assumed):
- Repo westccmortgage/Ourmtg. App lives in the ourmtg/ subdirectory; root netlify.toml sets
  base = "ourmtg" ON PURPOSE — do not flatten it.
- This is a WORKING Vite/React SPA (17 pages, magic-link auth, borrower/realtor/LO portals,
  secure documents) on 18 Netlify Functions and 12 tables (migrations 036–039). It builds
  (`npm run build`) and syntax-checks (`npm run check`). Read OURMTG-CURRENT-STATE-AUDIT.md
  before touching anything.
- GRCRM is the source of truth (shared Supabase project). The projector sync-loan-file.mjs
  reads app_state (wcci-deals) read-only. NEVER write borrower data into app_state.
- All functions use the service-role client and enforce authz in code via resolveAccess /
  isInternal / canSeeFinancials (_lib/portal.mjs). Reuse these on every path.

BRANCH: create claude/ourmtg-phase1-hardening from the latest default branch. Do not deploy,
do not merge, do not apply migrations to production, do not change production env vars.

SCOPE (Phase 1 = hardening only; NO new domain tables, NO new features):
1. R1 (High): In netlify/functions/portal-settings-set.mjs, restrict site_settings writes to
   OURMTG_ADMIN_EMAILS ONLY. Remove the "owns ≥1 loan file" authorization path (any authed
   user can self-provision ownership via portal-loanfile-set, so that path is an escalation).
   Verify: a non-admin file owner → 403; an admin email → 200.
2. R2 (Medium): In _lib/cronGuard.mjs / sync-loan-file.mjs, require CRON_SECRET in ADDITION to
   the Netlify schedule header. Keep scheduled invocations working.
3. R3 (Medium): Add per-IP rate limiting to the public netlify/functions/lead-submit.mjs.
   Fail-open if the limiter itself errors; throttle abusive volume. Do not break legitimate
   single submissions or the portal_consent write.
4. R4 (Low): Fix the stale "OWNER only" header comments in portal-invite-create.mjs and
   portal-preapproval-set.mjs to reflect that isInternal (owner OR team) is the actual gate.
5. R6 (Medium): Add migration 039_site_settings to docs/OURMTG_DEPLOY.md (§1 + the table-count
   check → 12). Verify cron_heartbeat exists in the shared project; if it does NOT, add a new
   idempotent migration 040_cron_heartbeat.sql (create table if not exists) — draft it, do NOT
   apply it; note it in the deploy runbook for manual application.
6. R5 (start): Add a `test` script (node --test, no new runtime dependencies) and run the
   Phase 0 domain contract tests (ourmtg/src/domain). Add a CI workflow that runs
   `npm ci && npm run check && npm run build && npm test` on the ourmtg/ base.

HARD CONSTRAINTS:
- Do NOT rebuild any existing page, function, or table. This phase adds no domain schema.
- Do NOT weaken realtor/escrow/title financial blocks (RLS AND code).
- Do NOT store financial docs anywhere but the private ourmtg-docs bucket.
- Do NOT make preapproval_* projector-written (human-set only stays).
- Do NOT introduce a second stage/status/task model or duplicate any existing enum.
- Keep all new SQL idempotent and, if not yet meant to run, non-runnable and separate.
- Feature flags (ourmtg/src/domain/flags.js) stay default-off.

QA (run from ourmtg/, report exact output):
- npm run check         (expect: ok)
- npm run build         (expect: success; note bundle size)
- npm test              (expect: contract tests pass)
- Manually reason through / exercise: non-admin settings write is now 403; cron still runs with
  the secret; a normal lead still submits and writes one consent row.

DELIVERY:
- Branch name + base commit; files changed; commands run + exact results; migration impact
  (should be: none applied, at most one new idempotent 040 draft); any unresolved owner
  decision; confirmation that build + check + tests are green.

Do NOT start Phase 2 (loan_events / notification_deliveries). Do NOT deploy or merge.
```

---

## Why this prompt is correct (vs. the previous one)

- It **starts from a working app**, not "there is no frontend." The first task is hardening a real authorization gap (R1), not building login/dashboards that already exist.
- It names the **real files, real functions, real migration numbers (036–039)** and the real risks the audit found — none of which the backend-only audit could reference.
- It preserves the **actual architecture** (service-role + in-code authz, GRCRM projection, private bucket, human-set pre-approval) instead of proposing a greenfield backend.
- It defers new domain tables to Phase 2+ (`OURMTG-IMPLEMENTATION-PLAN.md`), so Phase 1 is small, reversible, and verifiable.
