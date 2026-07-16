# OURMTG — Phase 1C External-Findings Reconciliation (EXT-1 … EXT-13)

This document addresses the **external-review findings EXT-1 through EXT-13**. It is distinct from
`OURMTG-PHASE1C-REVIEW-FIXES.md` (the earlier self-review F1–F13): those self-discovered findings are
**not** relabeled as the external findings here. Each EXT below states its status, the exact files, the
implementation, the covering tests, and the test result.

- **Previous Phase 1C commit:** `d5dc099`
- **Corrected external-findings commit:** see git log at delivery (this branch,
  `claude/ourmtg-phase1c-operational-pilot`).
- **Migrations applied:** NONE.
- **Live database tests:** NOT RUN (no isolated database provided). Fake-adapter tests are **not**
  represented as live-database tests.
- **QA:** `npm run check` PASS · `npm test` **179/179** PASS · `npm run build` PASS.
- **Phase 1D:** NOT STARTED.

---

## EXT-1 — Loan-scoped organization — **RESOLVED**
**Files:** `docs/phase1c/migration/043_ourmtg_operational_pilot.sql` (organizations.slug unique;
`loan_files.organization_id`), `netlify/functions/_lib/orgAccess.mjs`, all four `portal-task-*.mjs`,
`portal-doc-complete.mjs`.
**Implementation:** org is resolved from the loan file's `organization_id` (`resolveTaskContext`), not a
caller's arbitrary membership. Internal users must have an **active** membership in that file's org
(`memberOfOrg` → `not_org_member` otherwise). Borrowers/co-borrowers resolve via `portal_access` with no
membership. Realtor/escrow/title → `forbidden_role`. Multi-org users resolve against the file's org.
Deterministic WCC upsert by `slug`, membership + `loan_files.organization_id` backfill (EXT-13 block).
**Tests:** `tests/orgAccess.test.mjs` — borrower-portal-no-membership ok; internal-without-membership
denied; multi-org resolves from file; cross-org denied; inactive membership denied; unprovisioned file →
503. **Result:** PASS.

## EXT-2 — No borrower SELECT on base task tables — **RESOLVED**
**Files:** migration `043` (REVOKE ALL on `loan_tasks`/`loan_events`/`loan_task_history`/`organizations`
from `anon,authenticated`; `organization_members` SELECT-own via RLS), `portal-task-*.mjs` (borrower reads
via the gateway only).
**Implementation:** the borrower never reads the base tables directly; all reads go through the
authenticated gateway, which returns field-scoped rows. `loan_events`/`loan_task_history` are internal-only.
**Tests:** `tests/taskRepo.test.mjs` (`scrubTaskForBorrower`, `listBorrowerVisibleTasks` scrub) prove the
gateway shape; SQL acceptance `OURMTG-TASK-PILOT-ACCEPTANCE.md §3` asserts `has_table_privilege('authenticated',
…,'SELECT') = false`. **Result:** adapter tests PASS; SQL privilege check is in the (NOT RUN) branch script.

## EXT-3 — SECURITY DEFINER RPC privileges — **RESOLVED**
**Files:** migration `043` (each RPC `set search_path = public`; DO block `REVOKE ALL FROM public/anon/
authenticated` + `GRANT EXECUTE … TO service_role`).
**Implementation:** RPCs never trust browser-provided org/actor/status/event — the gateway sets the actor
from the JWT and the DB derives the to-status + event. Execution is service_role-only.
**Tests:** SQL acceptance `§4` (`has_function_privilege('authenticated'/'anon', …,'EXECUTE') = false`;
`service_role = true`; `search_path` pinned). **Result:** in the (NOT RUN) branch script; not a live test.

## EXT-4 — Stale-state concurrency — **RESOLVED**
**Files:** migration `043` (`loan_tasks.revision`; `ourmtg_task_transition` locks `FOR UPDATE`, compares
`p_expected_revision`, raises `stale_task`, re-validates graph, derives event, bumps revision),
`netlify/functions/_lib/taskRepo.mjs` + `portal-task-transition.mjs` (pass `expectedRevision`).
**Implementation:** the event type is derived from the approved transition (`ourmtg_task_event_type`), not
an arbitrary caller value; a stale request writes nothing.
**Tests:** `tests/taskRepo.test.mjs` — "two writers, first wins, stale loser zero writes"; "stale reject
cannot overwrite an already-accepted task"; revision bump asserted. **Result:** PASS.

## EXT-5 — Atomic document finalize + task submit — **RESOLVED**
**Files:** migration `043` (`ourmtg_document_finalize_submit`), `netlify/functions/_lib/taskRepo.mjs`
(`finalizeDocumentSubmit`), `portal-doc-complete.mjs` (fail-closed storage verify → one RPC).
**Implementation:** one transaction validates document/task/loan/org + borrower participant + revision,
marks the document uploaded, links it, submits the task, appends history + event. Any failure rolls back
all. Storage existence is verified fail-closed (a list error → 502, never "allow").
**Tests:** `tests/taskRepo.test.mjs` — finalize atomic success; cross-loan rejected with nothing changed;
retry finalizes exactly once (deduped). **Result:** PASS.

## EXT-6 — Borrower-visible status reason — **RESOLVED**
**Files:** migration `043` (`loan_tasks.borrower_visible_status_reason`; set on reject/more-info, cleared
on resubmit/accept), `portal-task-transition.mjs` (require reason ≥3 chars for reject/more-info; internal
`reason` separate), `taskRepo.mjs` (`scrubTaskForBorrower` surfaces it), `src/lib/taskLabels.js`
(`reasonLabel` EN/ES/RU), `src/components/NeedsAttention.jsx` (renders the localized reason).
**Tests:** `tests/taskRepo.test.mjs` — reason set on more-info, cleared on resubmit; reject sets reason.
`tests/taskLabels.test.mjs` — `reasonLabel` EN/ES/RU + fallback; reject/more-info status labels EN/ES/RU.
**Result:** PASS.

## EXT-7 — Participant targeting — **RESOLVED**
**Files:** migration `043` (`responsible_user_id`, `shared_with_borrowers`), `taskRepo.mjs`
(`borrowerCanSeeTask`, `listBorrowerVisibleTasks` with the participant `.or(...)`), `portal-task-*.mjs`
(participant enforcement on list/detail/transition/upload), `portal-task-create.mjs` (requires a
participant OR shared), `src/components/TeamTaskCard.jsx` (shared/participant UI).
**Implementation:** audience = specific borrower, shared, or untargeted; internal (`loan_team`) tasks are
never borrower-visible; a task targeted to one borrower is invisible to another.
**Tests:** `tests/taskRepo.test.mjs` — `borrowerCanSeeTask` across shared/targeted/untargeted/other-borrower
(two identities `b1`/`b2`); `listBorrowerVisibleTasks` returns only borrower tasks, scrubbed. **Result:** PASS.

## EXT-8 — Complete idempotency — **RESOLVED**
**Files:** `netlify/functions/_lib/idempotency.mjs` (mandatory key `^[A-Za-z0-9_.:-]{8,200}$`, canonical
JSON, `request_hash`), `portal-task-create.mjs` + `portal-task-transition.mjs` (mandatory key, no random
fallback; bind hash to material payload / `{task,action,expectedRevision,actor,reason,borrowerVisibleReason,
evidence}`), migration `043` (compare `request_hash` → `idempotency_conflict`; `unique(organization_id,
idempotency_key)`).
**Tests:** `tests/idempotency.test.mjs` (key validation, canonical determinism, hash differs on payload);
`tests/taskRepo.test.mjs` (create dup same-hash → one task/same id; create dup diff-hash → conflict;
transition lost-response retry → one side effect; transition dup diff-hash → conflict);
`tests/requestGuard.test.mjs` (format). **Result:** PASS.

## EXT-9 — Notification intent idempotency — **RESOLVED**
**Files:** migration `043` (intent inserted **in the same transaction** as create/reject/more-info,
deterministically keyed `intent:<idempotency_key>`), `portal-task-transition.mjs` (removed the old
post-transition insert that referenced the undefined `org.organization_id`).
**Implementation:** no send occurs; the intent is a `notification.queued` `loan_events` row. The prior bug
(transition path referencing an undefined org variable) is gone — the intent is written inside the RPC.
**Tests:** `tests/taskRepo.test.mjs` — "reject writes exactly one borrower notification intent in the same
transaction" (intent count = 1; lives in `loan_events`); create writes exactly one intent.
`tests/notificationIntent.test.mjs` (mapping, no send). **Result:** PASS.

## EXT-10 — Server-side feature flags — **RESOLVED**
**Files:** `netlify/functions/_lib/featureFlags.mjs` (`FF_TASK_PILOT`, `FF_LOAN_TEAM_TASK_PILOT`,
fail-closed), all four `portal-task-*.mjs` + `portal-doc-complete.mjs` (borrower list/detail/transition +
task-linked upload require `FF_TASK_PILOT`; team create/review require `FF_LOAN_TEAM_TASK_PILOT`; `404`
when off), `.env.example` (documents both, notes `VITE_FF_*` is presentation-only).
**Tests:** `tests/featureFlags.test.mjs` — only `'true'`/`'1'` enable; missing/malformed/`VITE_*` → OFF.
**Result:** PASS.

## EXT-11 — Full request hardening — **RESOLVED**
**Files:** `netlify/functions/_lib/requestGuard.mjs` (JSON-only 415, size cap 413, empty/invalid 400,
array/non-object reject, `__proto__`/`constructor`/`prototype` reject, UUID/enum/bounded-string/timestamp
validators), applied in `portal-task-create.mjs` + `portal-task-transition.mjs` (+ UUID checks in
list/detail/doc-complete). Generic client errors; PII-safe logs (consistent with Phase 1A).
**Tests:** `tests/requestGuard.test.mjs` — content-type, empty, size cap, invalid JSON, array, prototype
pollution, UUID/enum/timestamp/bounded-string. **Result:** PASS.

## EXT-12 — Retain audit trail — **RESOLVED**
**Files:** migration `043` — `loan_events`/`loan_tasks` reference org + file with `ON DELETE RESTRICT`;
`loan_task_history.task_id` `ON DELETE RESTRICT`; append-only triggers on `loan_events`/
`loan_task_history`; `loan_tasks.archived_at` for controlled soft archive.
**Implementation:** a cascade cannot erase immutable evidence; a task cannot be hard-deleted while history
references it; updates/deletes on the audit tables RAISE.
**Tests:** SQL acceptance `§5` (immutability RAISE on update/delete; `delete from loan_tasks` RESTRICT
RAISE). **Result:** in the (NOT RUN) branch script; adapter tests confirm the append-only model shape.

## EXT-13 — Deterministic org backfill — **RESOLVED**
**Files:** migration `043` (organizations.slug NOT NULL UNIQUE; commented backfill: preflight, upsert on
`conflict (slug)`, membership backfill, `loan_files.organization_id` backfill, null/mismatch report,
validation queries, rollback).
**Implementation:** identity is the stable `slug` `west-coast-capital-mortgage` — never `display_name`;
never `ON CONFLICT DO NOTHING` on a non-stable key; a `display_name`-under-different-slug collision raises
in preflight so conflicts stop clearly.
**Tests:** SQL acceptance `§2` (`files_without_org = 0`, `owners_without_membership = 0`,
`count(slug) = 1`). **Result:** in the (NOT RUN) branch script.

---

## Test inventory added/updated for the EXT findings
- `tests/orgAccess.test.mjs` (NEW) — EXT-1.
- `tests/featureFlags.test.mjs` (NEW) — EXT-10.
- `tests/requestGuard.test.mjs` (NEW) — EXT-11.
- `tests/idempotency.test.mjs` (NEW) — EXT-8.
- `tests/taskRepo.test.mjs` (REWRITTEN fake DB to the Rev 2 RPC contract) — EXT-4/5/6/7/8/9 + core atomicity.
- `tests/taskLabels.test.mjs` (EXPANDED) — EXT-6.

**Fake-adapter caveat:** the `tests/*.mjs` suite injects in-memory fakes; it is not a live-database test.
SQL-level acceptance for EXT-2/3/4/5/12/13 lives in `OURMTG-TASK-PILOT-ACCEPTANCE.md` and has **not** been
run — no isolated database was provided.

## What d5dc099 fixes were kept
The useful hardening from `d5dc099` (fail-closed storage verify in `portal-doc-complete`, the
functions-local self-contained state machine `taskLifecycle.mjs` with its parity test, evidence
internal-only + capped, the `isInternal` import fix) is retained and folded into the Rev 2 endpoints.
