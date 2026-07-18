# OURMTG — Phase 1C Functional Completion Gate v1.0

This is the code-completion report for branch `claude/ourmtg-phase1c-operational-pilot` and PR #1 (base `main`). Production readiness is separate and remains blocked.

## Guardrails

- Migration 043: **UNAPPLIED**. It remains review source outside `supabase/migrations/`. Its reviewed dependency-ordered rollback companion `043_ourmtg_operational_pilot.rollback.sql` is review source only, hard-guarded against execution, and has **not** been run.
- PR #1: **OPEN, UNMERGED**.
- Production deploy: **NOT PERFORMED**.
- Phase 1D: **NOT STARTED**.
- Pilot flags: default off and not enabled here.
- Phase 1C task notifications: intent rows only; no task-path email/SMS/push/webhook send.
- Live database acceptance: **NOT RUN**.

## Verified QA

GitHub Actions completed successfully on the final functional tree:

- `npm ci` — PASS
- `npm run check` — PASS
- `npm test` — **205 / 205 PASS**
- `npm run build` — PASS
- Existing `npm audit` result remains 3 pre-existing advisories (1 moderate, 2 high); no advisory was hidden or waived.

The 205 count is the prior 194-test suite plus the net 11 additional functional-completion tests. Existing repository scenarios were retained in `taskRepoRegression.test.mjs` rather than deleted to make the rewritten contract suite green.

## Functional flow implemented

```text
team creates task
→ create RPC records created + assigned atomically (task ends assigned, revision 1)
→ borrower opens task (viewed)
→ document workflow begins task (in_progress)
→ borrower uploads only the exact bound document request
→ atomic finalize marks document uploaded + task submitted + history/event/intent
→ team sends to review
→ team accepts, rejects, or requests more information
→ borrower sees only the safe borrower-visible result
```

There is no direct `created|assigned|viewed|rejected|reopened → submitted` finalize shortcut. Finalize requires `in_progress`.

## Owner-approved defect resolution

1. **Lifecycle** — PASS. Create records `created` and `assigned`; borrower flow performs `view` and `begin`; finalize accepts only `in_progress`.
2. **Participant targeting** — PASS. Team chooses primary borrower, co-borrower, or all approved borrowers. Specific targets are validated against `portal_access`; the DB derives borrower vs co-borrower.
3. **Exact document binding** — PASS. Document tasks require `required_document_id`. Team selects the existing request, signed upload preparation verifies it, Documents renders only it, and finalize rejects any other document.
4. **Reasons and valid actions** — PASS. Reject, request-more-info, and reopen require a borrower-visible reason. Team UI renders only lifecycle-valid actions.
5. **End-to-end idempotency** — PASS at code/adapter level. Pending create/transition/finalize operations persist key, material payload, and expected revision across double-click, ambiguous failure, and refresh. RPC dedupe returns the original material result.
6. **Fail-closed linked finalize** — PASS. A supplied task ID never falls back to legacy completion. Invalid ID, disabled flag, missing task, unauthorized participant, wrong document, stale revision, or relationship mismatch fails without partial state.
7. **Database authority** — PASS at source-contract level. RPCs verify file organization, actor role/membership, participant, exact document, revision, reason, and canonical lifecycle before one atomic commit.
8. **Organization backfill** — PASS at migration-source level. The migration is **fail-closed** (M2): an identity-collision preflight, a preflight inventory that emits `RAISE NOTICE` counts and **refuses** (`backfill_refused`) on more than one target org, any file already in another organization, or any null-owner file; only then the operator-approved single-org assignment + owner-membership backfill; then zero-unmatched validation before `SET NOT NULL`. It never treats `NULL ⇒ WCC` blindly and never infers org from email domain; multi-org datasets are refused and require an explicit mapping.

## FCG-1 through FCG-14

| Gate | Status | Evidence / limitation |
|---|---|---|
| FCG-1 Baseline and scope | PASS | Cumulative Phase 0/1A/1B/1C tree retained; main is the PR base; CI green. |
| FCG-2 Migration and atomic transition | PASS (code contract) / BLOCKED (live DB) | One RPC transaction, revision lock, DB graph, reasons, audit and intent. Migration remains unapplied. |
| FCG-3 Repository boundary | PASS | All authoritative task mutations use `taskRepo` and RPCs; errors map to stable domain/persistence results. |
| FCG-4 Organization and endpoint contracts | PASS | Loan-scoped org, internal membership, portal access, participant scoping, scrubbed borrower fields. |
| FCG-5 Document-to-task linking | PASS | Exact `required_document_id`, task-bound signed upload, atomic finalize, no task fallback. |
| FCG-6 Notification intent only | PASS | Task operations write minimal `notification.queued` events in-transaction. Task path invokes no delivery provider. Legacy task-less upload email behavior is unchanged and separate. |
| FCG-7 Borrower pilot UI | PASS (code/static) / BLOCKED (real-device run) | Real tasks, exact document, lifecycle prep, server reconciliation, localized task state. No browser-device run was fabricated. |
| FCG-8 Team pilot UI | PASS | Verified participant/document selection, persistent operations, distinct states/errors, valid actions only. |
| FCG-9 Trilingual labels | PASS | EN/ES/RU coverage tests for borrower task states/actions/reason framing. |
| FCG-10 Cash-to-close boundary | PASS | No authoritative cash-to-close engine introduced; existing planning adapter remains decoupled and flag-gated. |
| FCG-11 Automated evidence | PASS (code) / BLOCKED (live DB/device) | 205 tests, check and build pass. SQL concurrency/RLS/RPC privilege and real-device checks require approved environments. |
| FCG-12 Functional scenario proof | PASS (fake adapter) / BLOCKED (live DB) | Full create→view→begin→finalize→review flow, failure rollback, idempotency and no-send contracts tested without shared DB mutation. |
| FCG-13 Documentation accuracy | PASS | Architecture, migration, API, acceptance and reports distinguish implemented, unapplied, tested and blocked work. |
| FCG-14 Commit discipline | PASS after delivery squash | Final branch is reduced to one functional-completion commit above `0d73dac`; PR remains open/unmerged. |

## Test evidence added or retained

- `taskRepo.test.mjs` — final create/assign, participant, binding, lifecycle, revision, atomic finalize, reasons and material-result idempotency.
- `taskRepoRegression.test.mjs` — retained prior atomicity/security/idempotency/AI/cross-org regression coverage.
- `pendingOps.test.mjs` — persistent client operation reuse and ambiguous-result retention.
- `taskUi.test.mjs` — valid action rendering and borrower preparation actions.
- `functionalCompletionContract.test.mjs` — migration/endpoints/UI structural contracts and task-path no-send.
- `sqlLifecycleParity.test.mjs` — SQL and canonical server/domain lifecycle parity.
- Existing Phase 0/1A/1B/EXT suites remain in the full run.

## Production-readiness blockers

Code completion does **not** authorize production use. The following remain required:

1. independent review of migration 043;
2. approved isolated Supabase branch and migration plan;
3. live SQL/RLS/RPC privilege, concurrency, rollback and backfill acceptance;
4. preview environment with server/client pilot flags and separate test identities;
5. real-device/mobile browser validation;
6. independent review and explicit approval of PR #1;
7. explicit merge/deploy approval.

Until those steps complete, migration 043 stays unapplied and PR #1 stays unmerged.
