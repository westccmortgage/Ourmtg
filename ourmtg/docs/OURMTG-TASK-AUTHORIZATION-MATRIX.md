# OURMTG — Task Authorization Matrix (Phase 1C, external-review hardened)

Server-enforced (fail-closed server flag + JWT + loan-scoped org membership + `resolveAccess` + pure
task service + authoritative RPC). Frontend gating is not security. Cross-org and guessed-ID requests
are denied. Tested in `tests/taskRepo.test.mjs`, `tests/orgAccess.test.mjs`, `tests/featureFlags.test.mjs`,
`tests/requestGuard.test.mjs`, `tests/idempotency.test.mjs`, `tests/taskService.test.mjs`,
`tests/access.test.mjs`, `tests/roleVisibility.test.mjs`.

| Capability | Borrower/Co-borrower (own file) | Realtor | Escrow/Title | Loan team (org member) | Admin |
|---|---|---|---|---|---|
| List tasks | own **participant-scoped** borrower tasks, scrubbed | ❌ | ❌ (only explicitly permitted transaction tasks) | ✅ full | ✅ |
| View task detail | own, scrubbed (no history), only if a participant | ❌ | ❌ | ✅ + history | ✅ |
| See `internal_requirement` | ❌ | ❌ | ❌ | ✅ | ✅ |
| See `borrower_visible_status_reason` | ✅ (own) | ❌ | ❌ | ✅ | ✅ |
| Create task | ❌ | ❌ | ❌ | ✅ (must pick participant/shared) | ✅ |
| Assign | ❌ | ❌ | ❌ | ✅ | ✅ |
| Mark viewed / begin / submit | ✅ (own) | ❌ | ❌ | ✅ | ✅ |
| Upload linked document | ✅ (own, atomic finalize) | ❌ | ❌ | ✅ | ✅ |
| Accept / reject / more-info | ❌ | ❌ | ❌ | ✅ (reason required for reject/more-info) | ✅ |
| Complete (review-required) | ❌ | ❌ | ❌ | ✅ (only from team_review) | ✅ |
| Reopen / cancel | ❌ | ❌ | ❌ | ✅ | ✅ |
| Task targeted to another borrower | ❌ (not visible) | ❌ | ❌ | ✅ | ✅ |
| Cross-organization access | denied (`403`) | denied | denied | denied | n/a |
| AI actor (any action) | denied (`ai_forbidden`) — AI may only propose | | | | |
| Any action with the server flag OFF | `404` (fail-closed, EXT-10) | `404` | `404` | `404` | `404` |

Guarantees:
- **EXT-10 fail-closed:** with `FF_TASK_PILOT` / `FF_LOAN_TEAM_TASK_PILOT` unset, every task endpoint
  returns `404`. `VITE_FF_*` is presentation-only and authorizes nothing.
- **EXT-1 loan-scoped org:** the org comes from the loan file; internal callers must be active members
  of that org; borrowers/co-borrowers ride `portal_access` with no membership; a multi-org user is
  resolved against the file's org; cross-org (membership in a different org) is denied.
- **EXT-2 no borrower base SELECT:** `anon`/`authenticated` cannot read `loan_tasks`/`loan_events`/
  `loan_task_history` directly; the borrower reads only through the gateway. **EXT-3:** RPCs are
  `service_role`-only.
- **EXT-7 participant targeting:** a borrower sees a task only if it is shared, targeted to them, or
  untargeted; a task targeted to another borrower is not visible. Proven with two borrower identities on
  one loan.
- Borrower cannot accept their own submitted document (accept is team-only; review-required tasks reach
  `accepted` only from `team_review`).
- **EXT-4 concurrency / EXT-8 idempotency:** a stale write (`revision` mismatch) is rejected with zero
  writes; a duplicate key + same payload is deduped; a duplicate key + different payload is
  `idempotency_conflict`.
- `internal_requirement` and internal evidence/notes never appear in any borrower API response
  (`scrubTaskForBorrower`); `borrower_visible_status_reason` is the only reason the borrower sees.
- A guessed loan-file/task id without a grant resolves to no access (`resolveAccess → null`). Cross-org:
  the gateway rejects when the task/file org ≠ the caller's active membership; the RPC re-checks
  (`org_mismatch`).

This supplements `OURMTG-ENDPOINT-AUTHORIZATION-MATRIX.md` (1A) with the four `portal-task-*` endpoints
and the extended `portal-doc-complete`.
