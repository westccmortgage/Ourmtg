# OURMTG — Task Authorization Matrix (Phase 1C)

Server-enforced (JWT + org membership + `resolveAccess` + pure task service). Frontend gating is
not security. Cross-org and guessed-ID requests are denied. Tested in `tests/taskRepo.test.mjs`,
`tests/taskService.test.mjs`, `tests/access.test.mjs`, `tests/roleVisibility.test.mjs`.

| Capability | Borrower/Co-borrower (own file) | Realtor | Escrow/Title | Loan team (org member) | Admin |
|---|---|---|---|---|---|
| List tasks | own borrower tasks, scrubbed | ❌ | ❌ (only explicitly permitted transaction tasks) | ✅ full | ✅ |
| View task detail | own, scrubbed (no history) | ❌ | ❌ | ✅ + history | ✅ |
| See `internal_requirement` | ❌ | ❌ | ❌ | ✅ | ✅ |
| Create task | ❌ | ❌ | ❌ | ✅ | ✅ |
| Assign | ❌ | ❌ | ❌ | ✅ | ✅ |
| Mark viewed / begin / submit | ✅ (own) | ❌ | ❌ | ✅ | ✅ |
| Upload linked document | ✅ (own) | ❌ | ❌ | ✅ | ✅ |
| Accept / reject / more-info | ❌ | ❌ | ❌ | ✅ | ✅ |
| Complete (review-required) | ❌ | ❌ | ❌ | ✅ (only from team_review) | ✅ |
| Reopen / cancel | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cross-organization access | denied (`403`) | denied | denied | denied | n/a |
| AI actor (any action) | denied (`ai_forbidden`) — AI may only propose | | | | |

Guarantees:
- Borrower cannot accept their own submitted document (accept is team-only; review-required tasks
  reach `accepted` only from `team_review`).
- Realtor/escrow/title are structurally excluded from financial/document tasks (RLS + code + service).
- A guessed loan-file/task id without a grant resolves to no access (`resolveAccess → null`).
- Cross-org: gateway rejects when the task/file org ≠ the caller's active membership; the RPC re-checks (`org_mismatch`).
- `internal_requirement` and internal evidence/notes never appear in any borrower API response (`scrubTaskForBorrower`).

This supplements `OURMTG-ENDPOINT-AUTHORIZATION-MATRIX.md` (1A) with the four `portal-task-*` endpoints.
