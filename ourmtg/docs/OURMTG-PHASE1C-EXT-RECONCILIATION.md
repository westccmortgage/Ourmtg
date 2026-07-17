# OURMTG — Phase 1C External Findings (EXT-1…EXT-13)

This document maps the externally supplied findings to the final Phase 1C implementation. It remains distinct from the earlier self-review in `OURMTG-PHASE1C-REVIEW-FIXES.md`.

## Delivery status

- Branch: `claude/ourmtg-phase1c-operational-pilot`
- PR: #1, base `main`, open/unmerged
- Migration 043 applied: **NO**
- Live DB tests: **NOT RUN**
- Phase 1D: **NOT STARTED**
- QA: check PASS · **206/206 tests PASS** · production build PASS

## EXT findings

### EXT-1 — Loan-scoped organization — RESOLVED in code/source

`loan_files.organization_id` is the organization authority. Internal users need active membership in that organization; borrower/co-borrower access comes from the file-specific portal grant. Multi-org users resolve against the file, never their first membership. The migration performs deterministic single-org pilot backfill and stops on mismatches.

Evidence: migration 043, `orgAccess.mjs`, `orgAccess.test.mjs`. Live backfill acceptance remains unrun.

### EXT-2 — No borrower SELECT on operational base tables — RESOLVED in source

Browser roles have no select privilege on `loan_tasks`, `loan_events` or `loan_task_history`. Borrower reads pass through scrubbed gateway endpoints.

Evidence: migration 043, `taskRepo.mjs`, borrower scrub/list tests. Live privilege checks remain unrun.

### EXT-3 — SECURITY DEFINER RPC lockdown — RESOLVED in source

Operational RPCs use a fixed search path; execution is revoked from PUBLIC/anon/authenticated and granted to service role only. Gateway actor context is revalidated by RPC relationship checks.

Evidence: migration 043 and acceptance plan. Live `has_function_privilege` checks remain unrun.

### EXT-4 — Stale-state concurrency — RESOLVED at code/contract level

Tasks carry revision. Transition locks the row, checks expected revision, validates the canonical graph, derives status/event and writes atomically. Same-key retries return the original result before stale-state validation; a distinct stale operation writes nothing.

Evidence: migration 043, `taskRepo.mjs`, final task repository and regression suites. True DB concurrency smoke remains unrun.

### EXT-5 — Atomic document finalize + task submit — RESOLVED at code/contract level

The task path verifies private object existence fail-closed, exact file/org/participant/document/revision/state, then atomically writes document uploaded, task submitted, history, domain event and intent. No partial success is returned.

Evidence: migration 043, task-aware upload/finalize endpoints, task repository suites. Live forced-failure rollback remains unrun.

### EXT-6 — Borrower-visible status reason — RESOLVED

Reject, request-more-info and reopen require a safe borrower-visible reason at gateway and RPC. Internal notes remain separate. The reason is exposed through the scrubbed borrower contract and cleared on re-engagement/submission/acceptance/completion.

Evidence: transition endpoint/RPC, `NeedsAttention`, EN/ES/RU label tests, repository tests.

### EXT-7 — Participant targeting — RESOLVED

Task audience is specific primary borrower, specific co-borrower, or shared with all approved borrower participants. Specific target type is derived from `portal_access`; there is no implicit null-target audience. Team UI loads verified participants and exact documents.

Evidence: migration constraints/RPC, `orgAccess.mjs`, `TeamTaskCard`, repository/org tests.

### EXT-8 — Complete idempotency — RESOLVED at code/adapter level

Create, transition and finalize require stable client operation keys and canonical request hashes. Pending key/material/revision persist through double-click, ambiguous response and refresh. Duplicate RPC calls return original material results; changed material conflicts.

Evidence: `idempotency.mjs`, `pendingOps.js`, endpoints/RPCs, pending-op and repository suites. True concurrent DB race remains unrun.

### EXT-9 — Notification intent idempotency — RESOLVED

Intent is inserted inside the authoritative transaction with a deterministic key. Failed operations create no intent; retries create no duplicate. Task-linked Phase 1C paths invoke no delivery provider.

Evidence: migration 043, task-path no-send contract test, notification/repository tests.

### EXT-10 — Server-side feature flags — RESOLVED

`FF_TASK_PILOT` and `FF_LOAN_TEAM_TASK_PILOT` fail closed. Client `VITE_FF_*` values do not authorize backend behavior. A supplied task ID with the server flag off never falls back to legacy document completion.

Evidence: feature flag helper/endpoints and tests.

### EXT-11 — Full request hardening — RESOLVED

Phase 1C POST paths enforce JSON, size limits, UUID/enum/date/string validation, dangerous-key rejection and safe errors. Task-aware upload preparation/finalization apply the same guard.

Evidence: `requestGuard.mjs`, task/upload endpoints and request-guard tests.

### EXT-12 — Retain audit trail — RESOLVED in source

Operational audit tables are append-only. File/org/task relationships use restrict/no-action semantics; tasks and organizations support archive state rather than silent cascading deletion.

Evidence: migration 043 and acceptance plan. Live FK/trigger checks remain unrun.

### EXT-13 — Deterministic organization backfill — RESOLVED in migration source

The migration uses unique slug `west-coast-capital-mortgage`, stops on conflicting identity, upserts deterministically, assigns files, creates same-org owner memberships, validates organization-scoped results, and only then sets the file organization column non-null.

Evidence: migration 043. Live branch apply remains unrun.

## Final test inventory relevant to EXT work

- `orgAccess.test.mjs`
- `featureFlags.test.mjs`
- `requestGuard.test.mjs`
- `idempotency.test.mjs`
- `taskRepo.test.mjs`
- `taskRepoRegression.test.mjs`
- `pendingOps.test.mjs`
- `taskUi.test.mjs`
- `taskLabels.test.mjs`
- `taskLifecycleParity.test.mjs`
- `sqlLifecycleParity.test.mjs`
- `functionalCompletionContract.test.mjs`
- existing Phase 0/1A/1B security, role, AI and upload suites

Code/source findings are complete and independently reviewable. Database/environment claims remain blocked until the isolated-branch acceptance plan is approved and executed.
