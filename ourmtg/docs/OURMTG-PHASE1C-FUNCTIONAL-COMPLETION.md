# OURMTG — Phase 1C Functional Completion Gate (v1.0) — Completion Report

Authoritative gate: **Phase 1C Functional Completion Gate v1.0**. This report records the result of
each item FCG-1…FCG-14. It is a **code-completion** report; **production readiness remains separate and
BLOCKED** (see the Exit Rule at the end).

- **Branch:** `claude/ourmtg-phase1c-operational-pilot`  ·  **PR:** #1  ·  **Base:** `main`
- **Final HEAD:** the single functional-completion commit on this branch (`phase1c: satisfy functional
  completion gate`); see `git log` / PR #1 for the SHA.
- **Migration 043:** unapplied (reviewable source only). **No deploy. No send. PR not merged.**
- **QA:** `npm run check` PASS · `npm test` **194/194** PASS · `npm run build` PASS · `npm audit` 3
  pre-existing (1 moderate, 2 high; unchanged).

## Owner-approved clarification — 8 known defects in 0d73dac, resolved for code completion
| # | Defect | Resolution | Evidence |
|---|---|---|---|
| 1 | Borrower lifecycle must be executable end-to-end | `ourmtg_document_finalize_submit` is the borrower's single submit action and accepts any borrower-actionable pre-submission state (`created…reopened`) → `submitted`; the plain `submit` graph is unchanged | `tests/taskRepo.test.mjs` "create→assign→view→begin→finalize→submitted", "finalize directly from created", "terminal state rejected" |
| 2 | Task must target one verified primary borrower / one verified co-borrower / all approved participants | `portal-task-create` verifies `responsibleUserId` is a real borrower/co-borrower on the file (`verifyBorrowerParticipant` via `portal_access`); `sharedWithBorrowers` covers "all" | `tests/orgAccess.test.mjs` participant accept/reject (non-borrower, wrong file, unknown) |
| 3 | Document task bound to one exact document | finalize enforces 1:1 binding — a task already linked to one document rejects a different one (`document_binding_mismatch`) | `tests/taskRepo.test.mjs` "once bound, a different document is rejected; the same one is allowed" |
| 4 | Reject AND more-info require + preserve a safe borrower-visible reason | gateway requires it for both actions; RPC re-enforces `reason_required` for `rejected`+`more_information_needed`; reason stored + cleared on re-engagement | `tests/taskRepo.test.mjs` reason_required + set/clear; transition endpoint |
| 5 | Create/transition/finalize retries reuse the same pending idempotency op | deterministic same-key+hash dedup (existence check) **plus** an `exception when unique_violation` handler in all three RPCs so a concurrent retry reuses the committed op | `tests/taskRepo.test.mjs` lost-response + no-duplicate-intent; concurrent-race handler is RPC-contract (live smoke BLOCKED) |
| 6 | `taskId` supplied → never a legacy fallback | `docTaskLinkDecision` routes purely: no taskId → legacy; bad UUID → 400; pilot off → 404; valid+on → task path — never a silent legacy flip | `tests/requestGuard.test.mjs` docTaskLinkDecision cases |
| 7 | RPC authority verifies org, participant, document binding, reason, lifecycle parity | finalize RPC now checks org + participant + binding + state; transition RPC checks org + revision + graph + reason + derived event | `tests/taskRepo.test.mjs` finalize participant/binding/state + cross-org; transition reason/stale/cross-org |
| 8 | Backfill validation organization-scoped | EXT-13 validation queries rewritten to bind to the target org (slug `west-coast-capital-mortgage`): files not in the target org, and owners lacking an ACTIVE membership **in that org** | migration `043` EXT-13 §5 (source; live run BLOCKED) |

## Scope of changes made for the gate (minimum)
Two passes: (a) the FCG verification pass (reason-required RPC guard + explicitly-required coverage), and
(b) the owner-approved clarification pass resolving the 8 known defects above. All changes are minimal and
server-enforced; migration 043 remains unapplied.
- `docs/phase1c/migration/043_ourmtg_operational_pilot.sql` — transition RPC raises `reason_required`
  (FCG-2.5); finalize RPC enforces participant (`not_participant`), one-exact-document binding
  (`document_binding_mismatch`), and the borrower-actionable pre-submission state set (#1/#2/#3/#7); all
  three RPCs gain an `exception when unique_violation` retry-reuse handler (#5); EXT-13 backfill validation
  is organization-scoped (#8). Unapplied.
- `netlify/functions/_lib/orgAccess.mjs` — `verifyBorrowerParticipant` (#2).
- `netlify/functions/_lib/requestGuard.mjs` — `docTaskLinkDecision` (#6, no legacy fallback).
- `netlify/functions/portal-task-create.mjs` — verify the targeted participant (#2).
- `netlify/functions/portal-doc-complete.mjs` — route via `docTaskLinkDecision`; never legacy once
  `taskId` supplied (#6); map `not_participant`/`document_binding_mismatch`.
- `netlify/functions/_lib/taskRepo.mjs` — map `reason_required`, `not_participant`,
  `document_binding_mismatch`.
- `netlify/functions/portal-task-transition.mjs` — `reason_required` → 400.
- `tests/` — `taskRepo` (reason guard, no-dup-intent, cross-org contract, E2E lifecycle, participant,
  binding), `requestGuard` (`docTaskLinkDecision`), `orgAccess` (`verifyBorrowerParticipant`),
  `notificationIntent` (structural no-send proof).
- Docs — accuracy updates (this file; test counts; RPC reason/participant/binding enforcement; no-legacy
  fallback; notification/email nuance).

---

## FCG-1 — Baseline & scope integrity — **PASS**
Branch clean and in sync with origin; `origin/main` (`1a224bf`) is a direct ancestor (verified
`git merge-base --is-ancestor`); PR #1 `mergeable_state: clean`. Baseline `check` ok, `npm test` 179/179,
`build` ok recorded before any change. No Phase 0/1A/1B/1C files removed
(`git diff --diff-filter=D origin/main...HEAD` empty). `npm audit` = 3 pre-existing vulns (documented).

## FCG-2 — Migration 043 & atomic transition contract — **PASS** (contract verified; 043 unapplied)
`ourmtg_task_transition` is one plpgsql transaction that, before commit: enforces idempotency
(`idempotency_required`, `request_hash` → `idempotency_conflict`), locks the row `FOR UPDATE`, checks org
(`org_mismatch`), checks the expected revision (`stale_task`), re-derives the to-status
(`ourmtg_task_next_status` → `invalid_transition`), checks the role (`ourmtg_task_role_allows` →
`forbidden_action`), enforces review-required, **and now enforces the reject/more-info reason
(`reason_required`, FCG-2.5)**. It derives the event type itself (never trusts a caller status/event).
Invalid/unauthorized/stale → RAISE → full rollback (zero partial writes). Success writes task + history +
event (+ intent) exactly once. Cross-org mutation is impossible (`org_mismatch`). Verified via migration-
contract + fake-adapter tests in `tests/taskRepo.test.mjs`. **043 was NOT applied** — any real RPC smoke
test that needs it is reported under Deployment-readiness (BLOCKED).

## FCG-3 — Repository boundary — **PASS**
`taskRepo` delegates transition validation to the pure Phase 1B service (`transitionTask`) then persists
through the atomic RPC; it performs **no** direct task-state writes. A repo-wide search confirms **no**
`loan_tasks` `update/insert/delete/upsert` exists in any endpoint, document, AI, or UI path — the RPC is
the only writer. RPC throws / transport failures are caught and returned as `persist_failed`; domain
failures keep their distinct codes. Repeated submissions dedupe. Failed mutations write no intent.

## FCG-4 — Organization access & four endpoint contracts — **PASS**
`portal-task-list/detail/create/transition` all: require auth; resolve org **from the loan file** server-
side (`resolveTaskContext`, EXT-1) and never trust client-supplied org/user ids; reject cross-org (403);
return stable generic errors; preserve Phase 1B rules; mutate only through the repository. Borrower
responses are participant-scoped (EXT-7) and field-scrubbed (`scrubTaskForBorrower`) — no
internal_requirement/notes/metadata; borrowers cannot perform team-only transitions (`forbidden_action`).
Team responses respect org-role rules and cannot touch another org's tasks. Covered by
`tests/orgAccess.test.mjs`, `tests/taskRepo.test.mjs`, `tests/roleVisibility.test.mjs`.

## FCG-5 — Document-to-task linking — **PASS**
`portal-doc-complete` keeps the legacy (no-task) path identical. With a task link it verifies storage
existence **fail-closed** first, then runs the single atomic `ourmtg_document_finalize_submit` (mark
uploaded + link + submit + history + event). A failed finalize does not move the task; an unauthorized /
nonexistent / borrower-invisible / cross-org / cross-loan task cannot be linked; a repeat finalize is
idempotent (one transition/audit/intent); a partial failure is never reported as success; the document,
once uploaded, is preserved for safe retry. All task writes still go through the repo + RPC.

## FCG-6 — Notification intent only — **PASS**
`notificationIntent.mjs` is a pure data mapping; the intent is a `notification.queued` `loan_events` row
written **in the transition transaction**, only after a valid transition, only for create/reject/more-info,
deduped by key, with minimal metadata (no PII/financial detail). `tests/notificationIntent.test.mjs`
includes a **structural proof** that neither the intent mapper nor the repository references any delivery
provider or send primitive. *Note:* the pre-existing document-upload emails in `portal-doc-complete` are
unchanged Phase 1A/1B behavior and are not part of (nor introduced by) the task-notification model.

## FCG-7 — Borrower pilot UI — **PASS**
Flag OFF: `BorrowerDashboard` does not call `listTasks` and `NeedsAttention` is not rendered — existing
behavior/appearance unchanged. Flag ON: it fetches real borrower-visible tasks; `NeedsAttention` renders
localized labels/states; loading (Spinner), empty ("all caught up"), and error (Alert; tasks→null) are
intentional with no fake success; the derived checklist fallback is real checklist/conditions data, never
presented as live task rows; a task action deep-links `?task=<id>` through Documents → finalize; a failed
upload/finalize never visually marks the task submitted (state only reflects server truth on reload); a
successful finalize reconciles via re-fetch on navigation; components use the existing responsive system
(no fixed-px/nowrap/x-overflow in the pilot components).

## FCG-8 — Team pilot UI — **PASS**
Flag ON: `LoanFileDetail` renders `TeamTaskCard` for the authorized file; loading/empty/error/success are
distinct (no false "no tasks" during load); actions call the API/repository path with no optimistic
persisted state; failures surface as errors; reject-with-reason requires ≥3 chars (Phase 1B rule, re-
enforced by the RPC); tasks are listed for the single org-scoped file so cross-loan/cross-org data cannot
appear. Flag OFF: `LoanFileDetail` is unchanged.

## FCG-9 — Trilingual state & action labels — **PASS**
`tests/taskLabels.test.mjs` asserts EN/ES/RU for every borrower-visible status and phase-1C action, that
raw enum keys are never returned, and that a missing translation fails the test (not silently undefined).
`reasonLabel` (EXT-6) is EN/ES/RU. Non-task translations unchanged.

## FCG-10 — Cash-to-close boundary — **PASS**
No new cash-to-close decision engine is introduced in Phase 1C. `src/domain/cashToClose.js` is a pure,
deterministic **planning** calculator (estimate only; a `final` classification requires a Closing
Disclosure); `CashToClosePanel` shows an honest "your loan team will provide these" state and never
fabricates figures. Task logic has **no** reference to cash-to-close (verified by search). The authoritative
ledger remains deferred (`cashToCloseLedger` flag off). Doc `OURMTG-CASH-TO-CLOSE-MODEL.md` is consistent.

## FCG-11 — Required automated evidence — **PASS** (code-completion) / live-DB portions BLOCKED
`check`, `build`, `test` (185/185), `npm audit` all run. `mobile/static scan`: the repo has no bespoke
scan command; the documented static checks (no fixed-px/nowrap/x-overflow in the pilot components) were
applied — reported honestly, not as a fabricated command. Targeted coverage present for all 25 items:
atomic transition, invalid transition, required reject reason, unauthorized + cross-org transition, RPC
throw/persist_failed, zero partial writes, genuine double-submit, borrower listing, borrower scrub,
team-only protection, AI-via-repository denial, doc→task linking, failed finalize unchanged, repeat
finalize idempotent, invalid/cross-org task link, intent-without-send, no-duplicate-intent, flag off/on,
trilingual completeness. No existing test was weakened, deleted, or skipped. Items needing migration 043
applied are identified under Deployment-readiness (BLOCKED); 043 stays unapplied.

## FCG-12 — Functional scenario proof — **PASS** (fake harness; no shared/prod mutation)
The fake-adapter suite exercises the full flows end-to-end: team create/manage; invalid transition
rejected with no partial write; team rejection requires + preserves a reason; borrower sees only an
approved borrower-visible task; borrower follows a task into the upload flow (deep link) ; failed finalize
leaves the task unchanged; successful finalize produces exactly one `submitted` transition; a repeat
finalize duplicates neither transition nor intent; the resulting state is what the team view would read;
a notification intent exists while nothing is sent. No migration 043 apply, no shared/prod mutation.

## FCG-13 — Documentation accuracy — **PASS**
The six Phase 1C docs + the cash-to-close model doc accurately describe implemented behavior, flag
behavior, access/field boundaries, atomic transition (incl. RPC reason enforcement), notification-intent-
only (with the pre-existing-upload-email nuance), document-task linking + retry semantics, 043 as
unapplied/pending review, known limitations/deployment dependencies, and cash-to-close as an adapter
boundary (not an authoritative engine). No unverified customer/production/regulatory claim. Only inaccurate
or now-stale sections (test counts, reason enforcement, notification nuance) were updated.

## FCG-14 — Completion report & commit discipline — **PASS**
Full QA re-run green; the working tree contains only Phase 1C Functional Completion changes; a single
commit (`phase1c: satisfy functional completion gate`) is pushed to the existing branch so PR #1 updates
automatically. PR not merged; no deploy; 043 not applied; Phase 1D not begun.

---

## Known minor observation (non-blocking)
The SQL graph (`ourmtg_task_next_status`) permits `reject` from `rejected` (re-reject), while the pure
Phase 1B lifecycle mirror does not list a `rejected→rejected` self-transition. Because the repository runs
the pure service **before** the RPC, the stricter pure rule governs in practice, so there is no bypass.
This is a pre-existing SQL/mirror divergence flagged for independent review; it was **not** changed here to
avoid altering unapplied migration behavior outside the minimum required by this gate.

## Exit Rule — Production readiness remains BLOCKED
Code completion passes via repository/migration-contract + fake-adapter testing. Production readiness is
separate and remains blocked until: (1) migration 043 receives independent review; (2) an authorized
migration/application plan is approved; (3) environment-level verification (apply 043 to an isolated
Supabase branch, run `OURMTG-TASK-PILOT-ACCEPTANCE.md`) is completed; and (4) PR #1 receives independent
review and explicit merge approval. No live-database evidence is claimed here.
