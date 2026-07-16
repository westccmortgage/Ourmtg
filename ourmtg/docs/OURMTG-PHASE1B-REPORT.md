# OURMTG — Phase 1B Report (Borrower Operations Foundation)

## 1. Verified repository & branch
- Repository: `westccmortgage/Ourmtg` (verified: clean tree, not `main`, `fd0373f` ancestor, app files present).
- Branch: `claude/ourmtg-phase1b-borrower-operations`.
- **Base commit:** `fd0373f` (Phase 1A). **New commit:** see git log at delivery.

## 2. Phase 1A baseline re-verified (before any change)
`npm ci` ok · `npm run check` **ok** · `npm test` **59/59** · `npm run build` **success**. Proceeded.

## 3. What was built (all pure / flag-gated / draft-only; production behavior preserved)
- **Domain contracts** (`src/domain/lifecycles.js`): actor/responsible-party/source types, task types, the 13-state **task lifecycle**, the 11-state **disclosure lifecycle**, milestone types/statuses, **cash classifications**, third-party types/statuses, notification events/statuses, and the superset event catalog. `vocab.js` re-points `TASK_STATUS`/`EVENT_TYPES` at this single source (no forked enums; Phase 0 placeholder superseded).
- **Pure services (flag-gated, injected persistence):** task state machine + role/AI guards; append-only idempotent event ledger; disclosure state model; notification event model; AI-boundary contract.
- **Cash-to-close planning engine** (`cashToClose.js`) — deterministic, all 10 required rules.
- **Borrower value (additive, flag-gated):** "Needs your attention", cash-to-close panel, third-party progress, verified mortgage-team card. Loan-team: deterministic blockers + "what changed today".
- **Guarded draft schema** (10 entities) with the mandated `organization_id` boundary.
- **8 docs** (feature map, architecture, task-transition matrix, event catalog, visibility matrix, cash-to-close model, disclosure state model, this report).

## 4. Exact files changed
**New — domain/services:** `src/domain/lifecycles.js`, `cashToClose.js`, `visibility.js`, `services/{taskService,eventService,disclosureService,notifications,aiBoundary}.js`.
**New — lib/components:** `src/lib/needsAttention.js`, `src/lib/loanTeamOps.js`, `src/components/{NeedsAttention,CashToClosePanel,ThirdPartyPanel,TeamContactCard}.jsx`.
**Modified:** `src/domain/vocab.js`, `src/domain/flags.js`, `src/lib/config.js` (verified `TEAM` + LO NMLS default), `src/pages/BorrowerDashboard.jsx`, `src/pages/LODashboard.jsx`.
**New — drafts/docs:** `docs/phase1b/draft-migrations/OURMTG-1B-operational-schema.DRAFT.sql` (+ README); `docs/OURMTG-PHASE1B-CURRENT-FEATURE-MAP.md`, `OURMTG-PHASE1B-ARCHITECTURE.md`, `OURMTG-TASK-TRANSITION-MATRIX.md`, `OURMTG-EVENT-CATALOG.md`, `OURMTG-BORROWER-VISIBILITY-MATRIX.md`, `OURMTG-CASH-TO-CLOSE-MODEL.md`, `OURMTG-DISCLOSURE-STATE-MODEL.md`, this report.
**New — tests:** `tests/{cashToClose,taskService,eventService,disclosure,notifications,aiBoundary,roleVisibility,needsAttention,loanTeamOps}.test.mjs`.

## 5. Schema drafts created
One guarded, non-runnable file with 10 entities: `organizations`, `organization_members`, `loan_events` (append-only, idempotent), `loan_tasks`, `loan_task_history` (append-only), `loan_milestones`, `cash_to_close_items`, `cash_to_close_snapshots`, `disclosure_packages`, `third_party_items`. Every table carries `organization_id` + FKs to existing tables + RLS + rollback; immutability triggers on the append-only tables. Outside `supabase/migrations/`, no runnable sequence number, `RAISE EXCEPTION` guard.

## 6. Migrations applied
**None.** Phase 0 drafts 040/041/042 untouched; Phase 1B schema is draft-only.

## 7. Feature flags added (all default FALSE)
`taskServiceEnabled, eventServiceEnabled, borrowerWorkspaceV2, loanTeamWorkspaceV2, cashToClosePlanner, disclosureTracking, thirdPartyTracking, notificationEvents, aiSuggestions`. Enable per-environment via `VITE_FF_*` / `FF_*`.

## 8. Borrower features implemented (flag-gated for pilot; verified team card always on)
Needs-your-attention (deterministic from existing checklist + conditions), loan progress (existing 7-stage tracker), documents/signatures separation, money-needed-to-close planning view (labeled classification, never a quote), third-party progress placeholders (no fabricated data), verified mortgage-team card (West Coast Capital Mortgage · Office 310-654-1577 · Direct 310-686-5053 · westccmortgage@gmail.com · Anatoliy Kanevsky, CA DRE #01385024, NMLS #2775380 · Corp CA DRE #02440065, NMLS #2817729).

## 9. Loan-team features implemented (flag-gated)
Deterministic blocker rollup (files-with-blockers, missing docs, open conditions, awaiting-borrower) + "what changed today" (files with activity in the last 24h) — computed from stored data, explicitly **no AI-generated summaries**.

## 10. Tests added & total PASS count
**114 total / 114 pass / 0 fail** (was 59 at Phase 1A baseline → **55 new Phase 1B tests**). New suites: cash-to-close (10 required cases), task transitions + role/AI guards, event idempotency/immutability, disclosure state distinctness, notifications, AI boundary, role/visibility, needs-attention, loan-team ops. `test:domain` 5 · `test:security` (all `tests/`) 109. No external vendor calls; no production secrets; mocks/pure helpers only.

## 11. Build result
`npm run build` **success** — 185 modules, JS 568.56 kB (gzip 173.52 kB). Vite >500 kB chunk **warning only**.

## 12. Security regression result
No regression. Phase 1A controls intact and still green: admin-only settings, cron Bearer secret, public-endpoint abuse protection, upload policy, security headers, safe logging. Role/visibility + AI-boundary tests reinforce the access model. New services are pure, flag-off, and add no production surface.

## 13. Mobile QA result
Static verification (Playwright not added — see §16): the new components use only the existing responsive class system (`card/row/metrics/chip/callout/hint/btn`), introduce **no fixed pixel widths, no `white-space:nowrap`, no horizontal-overflow constructs**, and set a ≥44px tap target on the primary action. Needs-attention renders at the top. EN/ES/RU public funnel unchanged. Full device testing at 360×800 / 375×812 / 390×844 / 393×852 / 430×932 is recommended in a browser before enabling the flags in production.

## 14. Unresolved decisions
1. When to flip each pilot flag on (and for which files) — needs owner go-ahead.
2. Organization backfill strategy (owner_user_id → default organization) before the draft schema becomes real migrations.
3. Disclosure e-sign provider choice (DocuSign / Dropbox Sign / other) — adapter is provider-neutral, unintegrated.
4. Cash-to-close data source: manual LO entry vs Arive-fed once Arive is integrated.
5. Notification transport (reuse Resend for email; Twilio for SMS — deferred) and per-broker vs platform sender.

## 15. Remaining risks
1. **npm audit: 3 (1 moderate, 2 high)** — unchanged from 1A: `nodemailer` (runtime; CRLF mitigated by `sanitizeHeader`, upgrade to ^9 still recommended), `vite`/`esbuild` (dev-only). Not auto-fixed (breaking majors) — reported honestly.
2. Enhanced workspaces are **flag-off by default**, so borrower value is demonstrable only when flags are enabled per-environment (deliberate — no production behavior change this phase).
3. Cash-to-close UI shows structure + honest placeholders until real figures exist (no fabrication) — real numbers await LO entry / the draft ledger.
4. Third-party progress shows neutral placeholders until real data exists (no fabricated integration).
5. Draft schema not applied; the org-tenancy migration + backfill is future work.
6. No Playwright device automation added (dependency-stability trade-off) — mobile verified statically.

## 16. Rollback instructions
All changes are additive code/docs/tests + one guarded draft; nothing deployed or migrated.
- **Full:** `git revert <phase-1b-commit>` or reset to base `fd0373f`. No DB/env state to undo.
- **Selective:** delete the new `src/domain/*`/`services/*`, `src/lib/needsAttention.js`+`loanTeamOps.js`, and the 4 components; revert the additive blocks in `BorrowerDashboard.jsx`/`LODashboard.jsx` and the `vocab.js`/`flags.js`/`config.js` edits; delete the new `tests/*` and `docs/*`. No runtime impact.
- **Flags:** already default false — nothing to disable in production. Drafts were never applied.

## 17. Proposed Phase 1C prompt (outline)
```
OURMTG PHASE 1C — PILOT WIRING (first real operational tables, one org, guarded rollout)
Base: claude/ourmtg-phase1b-borrower-operations. No deploy/merge unless owner approves; if
migrations are approved, apply to a Supabase BRANCH database only, never production.
1. Author real migrations from the Phase 1B draft: organizations + organization_members +
   loan_events + loan_tasks + loan_task_history FIRST (with organization_id, backfill a default
   org from owner_user_id). Keep RLS default-deny; append-only triggers on ledgers.
2. Wire ONE pilot path server-side behind flags: emit loan_events from doc upload/accept/reject
   and stage change (idempotent), and create loan_tasks from loan_conditions + doc requests.
   Keep flags off in production; enable only on a pilot env/file.
3. Replace needsAttention's derived items with real loan_tasks when taskServiceEnabled is on
   (fall back to derived when off) — no duplicate task model.
4. Enable borrowerWorkspaceV2 + loanTeamWorkspaceV2 on the pilot env; run the 5-viewport mobile
   pass in a browser; capture screenshots.
5. Nodemailer → ^9 (review mailer SMTP), re-run npm audit; document residual.
6. Tests: service→DB integration against a Supabase branch (no prod), keep pure tests green.
Deliver: migrations authored/applied-to-branch, files, tests, audit before/after, mobile
evidence, remaining risks, rollback, Phase 1D outline. Stop after 1C.
```

Do not deploy · do not merge · do not apply migrations · do not change production env. Stopped after Phase 1B.
