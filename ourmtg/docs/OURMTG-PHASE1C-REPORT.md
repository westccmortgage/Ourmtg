# OURMTG — Phase 1C Report (Operational Pilot Wiring)

## Verified repository & branch
- Repository: `westccmortgage/Ourmtg` (verified: clean tree, not `main`, `ef8bb68` ancestor).
- Branch: `claude/ourmtg-phase1c-operational-pilot` · **Base commit** `ef8bb68` · **New commit**: see git log at delivery.
- **Baseline re-verified before changes:** `npm ci` ok · `check` ok · `npm test` **114/114** · `build` success.

## Mission delivered
The first production-shaped vertical slice: **team creates a borrower document task → borrower sees
it → opens it → uploads the document → task moves to submitted → team reviews (accept / reject /
request more info) → borrower sees the result**, with **every material transition writing an
immutable event + task-history row atomically**. Flag-gated (default off); migration written, NOT applied.

## External-findings reconciliation (EXT-1 … EXT-13)
This report predates the external review. The authoritative, per-finding reconciliation for EXT-1 through
EXT-13 (status, files, implementation, tests, results) is **`OURMTG-PHASE1C-EXT-RECONCILIATION.md`**. The
migration is now **Rev 2** (3 service_role-only RPCs, loan-scoped org via `loan_files.organization_id`,
revision-based concurrency, request-hash idempotency, in-transaction notification intents, `ON DELETE
RESTRICT` audit protection, deterministic slug backfill). The self-review `OURMTG-PHASE1C-REVIEW-FIXES.md`
(F1–F13) is a **separate** document and is not the external findings.

## Exact files changed
**New (backend):** `docs/phase1c/migration/043_ourmtg_operational_pilot.sql`;
`netlify/functions/_lib/{orgAccess,taskRepo,notificationIntent}.mjs`;
`netlify/functions/{portal-task-list,portal-task-detail,portal-task-create,portal-task-transition}.mjs`.
**Modified (backend):** `netlify/functions/portal-doc-complete.mjs` (optional `taskId` → submit-on-finalize).
**New (frontend):** `src/lib/taskLabels.js`; `src/components/TeamTaskCard.jsx`.
**Modified (frontend):** `src/lib/api.js` (task wrappers + `uploadDocument(taskId)`); `src/domain/flags.js`
(`taskPilot`, `loanTeamTaskPilot`); `src/components/NeedsAttention.jsx` (real tasks + fallback);
`src/pages/{BorrowerDashboard,LoanFileDetail,Documents}.jsx`.
**New (tests):** `tests/{taskRepo,taskLabels,notificationIntent}.test.mjs`.
**New (docs):** `OURMTG-PHASE1C-ARCHITECTURE.md`, `OURMTG-PHASE1C-DATA-MIGRATION.md`, `OURMTG-TASK-API.md`,
`OURMTG-TASK-AUTHORIZATION-MATRIX.md`, `OURMTG-TASK-PILOT-ACCEPTANCE.md`, this report; cash-to-close adapter appendix.

## Migration files created / migrations applied
Created: `docs/phase1c/migration/043_ourmtg_operational_pilot.sql` (organizations, organization_members,
loan_events, loan_tasks, loan_task_history + `ourmtg_task_create`/`ourmtg_task_transition` RPCs; FKs,
org boundary, indexes, `unique(organization_id, idempotency_key)`, append-only triggers, updated_at,
RLS, backfill, validation, rollback). **Migrations applied: NONE.** Outside `supabase/migrations/`; branch-only per acceptance doc.

## Transaction / RPC design
**Three** `SECURITY DEFINER`, `service_role`-only RPCs (Rev 2) perform the atomic writes.
`ourmtg_task_transition` takes an action + expected revision, locks the task `FOR UPDATE`, rejects a
`revision` mismatch (`stale_task`), re-validates the graph, **derives** the to-status + event server-side,
bumps the revision, and appends `loan_task_history` + `loan_events` (and a same-transaction notification
intent on reject/more-info) in **one transaction**. `ourmtg_task_create` and
`ourmtg_document_finalize_submit` are likewise atomic. Any failure RAISES and rolls back. Idempotency is a
mandatory key + `request_hash` (same key + same payload dedupes; different payload → `idempotency_conflict`).
Validation is also delegated to the canonical pure Phase 1B task service BEFORE the RPC for fast-fail. No
independent client-side history/event inserts.

## Endpoints added
`portal-task-list`, `portal-task-detail`, `portal-task-create`, `portal-task-transition` (+ extended
`portal-doc-complete`). No raw table CRUD exposed. See `OURMTG-TASK-API.md`.

## Authorization matrix
See `OURMTG-TASK-AUTHORIZATION-MATRIX.md`. Borrower: list/view own scrubbed tasks, view/begin/submit,
upload; NOT create/assign/accept/reject/complete, and never sees `internal_requirement`. Team: full
lifecycle on org files. Realtor/escrow/title: no financial/document tasks. Cross-org + guessed-id denied.
AI: no action (proposer only). Admin: separate from loan/task access.

## Borrower pilot behavior (`VITE_FF_TASK_PILOT`, default off)
"Needs your attention" renders real `loan_tasks` first (title, explanation, due date, blocking, action),
with a safe fallback to the derived checklist behavior when off/empty. Statuses are plain-language, EN/ES/RU.
Upload deep-links to the secure Documents flow (`?task=<id>`) which links the finalize to the task. No
fabricated tasks; internal fields never rendered.

## Loan-team pilot behavior (`VITE_FF_LOAN_TEAM_TASK_PILOT`, default off)
A focused card on the loan file: create ONE borrower document task (title, explanation, internal
requirement, due date, blocking, expected doc type), and review submitted tasks (to-review, accept,
reject-with-reason, request more info, reopen, complete). Not a generic workflow builder.

## Feature flags
`taskPilot`, `loanTeamTaskPilot` (both default FALSE). Enable per-environment via `VITE_FF_TASK_PILOT`
/ `VITE_FF_LOAN_TEAM_TASK_PILOT`. Notification model + AI remain disabled.

## Tests & PASS count
**179 total / 179 pass / 0 fail** (post-EXT). New EXT suites: `orgAccess` (EXT-1 loan-scoped org),
`featureFlags` (EXT-10 fail-closed), `requestGuard` (EXT-11 hardening + prototype-pollution),
`idempotency` (EXT-8 key/hash). `taskRepo` was rewritten to the Rev 2 RPC contract and now covers EXT-4
(stale/revision), EXT-5 (atomic finalize + rollback + cross-loan), EXT-6 (reason set/clear), EXT-7
(participant visibility, two borrowers), EXT-8 (idempotency conflict), EXT-9 (one intent in-tx).
`taskLabels` expanded for EXT-6. Existing task-service / AI-boundary / role-visibility suites unchanged.
No external vendor calls; no production secrets; injected adapters + pure helpers only — **fake-adapter
tests are NOT live-database tests.**

## Build result
`npm run build` **success** — JS 575.79 kB (gzip 175.62 kB); Vite >500 kB chunk **warning only**.

## Security regression result
No regression. All Phase 1A controls intact and green (admin allowlist, cron Bearer, rate limiting,
MIME policy, signed URLs, no-store, security headers, safe logging, JWT, service-role isolation). New
task endpoints are authenticated + org-scoped + loan-file-authorized; borrower reads field-scoped; RLS
not weakened.

## Database-test limitations (honest)
Repositories and atomicity/idempotency are proven with **injected fake adapters**, not a live database —
mocked persistence is NOT represented as a live DB test. The live acceptance is `OURMTG-TASK-PILOT-ACCEPTANCE.md`
(Supabase branch): apply migration, backfill, exercise the RPCs (atomicity, immutability, idempotency),
and run the end-to-end + cross-org/role denials. Not executed here (no branch DB; no production access).

## Mobile QA result
Static verification (no Playwright dependency added — Chromium present but Playwright is not a resolvable
module; adding it risks dep instability). New pilot components use only the existing responsive class
system: **no fixed pixel widths, no `white-space:nowrap`, no x-overflow**; primary borrower action is a
≥44px tap target; team review buttons wrap (`flex-wrap`); Russian labels wrap normally. Full device pass
at 360×800 / 375×812 / 390×844 / 393×852 / 430×932 recommended in a browser before enabling the flags.
With flags off, the current portal is unchanged.

## Remaining risks
1. `npm audit`: 3 (1 moderate, 2 high) unchanged — nodemailer (runtime; CRLF mitigated, upgrade to ^9 pending) + vite/esbuild (dev-only).
2. Live-DB behavior of the RPCs/RLS is acceptance-scripted but not executed here.
3. ~~Single-org pilot assumption~~ **RESOLVED (EXT-1):** `loan_files.organization_id` now exists; the gateway resolves a file's org from the file and supports multi-org users. Requires the EXT-13 backfill to report zero unprovisioned files before flags are enabled.
4. Notification intents are recorded (best-effort) but nothing is sent.
5. Full per-task upload wiring uses the existing checklist upload with a `?task` deep link; a dedicated per-task upload surface is a follow-up.
6. Flags default off ⇒ pilot value is demonstrable only when enabled per-environment.

## Unresolved decisions
1. When/where to run the branch acceptance and flip the pilot flags.
2. Add `loan_files.organization_id` now vs later (needed before multi-org).
3. Notification transport + when to activate sending (reuse Resend / add Twilio).
4. Whether team tasks should also be created from `loan_conditions` automatically in the pilot.

## Rollback instructions
Additive code/docs/tests + one unapplied migration. **Full:** `git revert <phase-1c-commit>` or reset to
`ef8bb68`; no DB/env to undo. **Selective:** delete the new `_lib/{orgAccess,taskRepo,notificationIntent}.mjs`
+ `portal-task-*.mjs`, revert `portal-doc-complete.mjs`, delete `TeamTaskCard.jsx`/`taskLabels.js`, revert the
`NeedsAttention`/`BorrowerDashboard`/`LoanFileDetail`/`Documents`/`api.js`/`flags.js` edits, delete new tests/docs.
**Flags:** already default off. **Migration:** never applied; nothing to roll back (branch rollback block provided).

## Proposed Phase 1D prompt (outline)
```
OURMTG PHASE 1D — PILOT DB ACCEPTANCE + HARDENING (still no production)
Base: claude/ourmtg-phase1c-operational-pilot. No deploy/merge to production. Apply the 043 migration
to a SUPABASE BRANCH only and run OURMTG-TASK-PILOT-ACCEPTANCE.md end to end; capture results.
1. Add loan_files.organization_id (additive) + backfill; switch the gateway to resolve a file's org
   from the file, not just caller membership; keep single-org behavior working.
2. Integration tests against the branch (task create→submit→review→accept) incl. atomicity, immutability,
   idempotency, cross-org/role denials — real DB, not mocks. Keep pure tests green.
3. nodemailer → ^9 (review mailer), re-run npm audit; document residual.
4. Wire the notification OUTBOX (still no send): promote notification-intent events into a
   notification_deliveries-shaped table (draft→real on branch) with idempotency; sending stays deferred.
5. Browser mobile pass at the 5 viewports with the pilot flags on (preview env); capture screenshots.
6. Optional: auto-create a borrower task from a new loan_condition (behind the pilot flag).
Deliver: branch-applied migration + acceptance evidence, files, tests (incl. live-DB), audit before/after,
mobile evidence, remaining risks, rollback, Phase 1E outline. Stop after 1D.
```

Do not deploy · do not merge · do not apply migrations to production · do not change production env. Stopped after Phase 1C.
