# OURMTG — Task Authorization Matrix (Phase 1C)

Authorization is server-enforced through fail-closed feature flags, verified JWT, `resolveAccess`, loan-scoped organization context, explicit participant audience, repository validation and service-role-only RPCs. Frontend visibility is not an authorization control.

| Capability | Borrower / Co-borrower | Realtor | Escrow / Title | Authorized loan team | Platform admin |
|---|---|---|---|---|---|
| List tasks | shared tasks and tasks specifically targeted to the authenticated participant; scrubbed fields | ❌ | ❌ | full rows for authorized file/org | no implicit file access |
| View task detail | own/shared scrubbed task; no history | ❌ | ❌ | full task + history | separate platform role |
| See internal requirement/reason/evidence/metadata | ❌ | ❌ | ❌ | ✅ | only with separate file authorization |
| See borrower-visible status reason | ✅ own/shared | ❌ | ❌ | ✅ | only with separate file authorization |
| Create task | ❌ | ❌ | ❌ | ✅, exact participant/shared audience + exact document | no ownership bypass |
| Assign task | ❌ | ❌ | ❌ | create RPC assigns; later assign only when lifecycle permits | no ownership bypass |
| Mark viewed / begin | ✅ own/shared | ❌ | ❌ | valid lifecycle only | no ownership bypass |
| Upload linked document | ✅ own/shared, exact required document only | ❌ | ❌ | review/request flow only | no ownership bypass |
| Submit through linked finalize | ✅ only from `in_progress` | ❌ | ❌ | n/a | n/a |
| Send to review / accept / reject / more info | ❌ | ❌ | ❌ | ✅ valid lifecycle; safe reason required where applicable | no ownership bypass |
| Complete / reopen / cancel | ❌ | ❌ | ❌ | ✅ valid lifecycle; reopen requires safe reason | no ownership bypass |
| Task targeted to another participant | not visible / not actionable | ❌ | ❌ | visible on authorized file | n/a |
| Shared task | visible/actionable to approved borrower participants | ❌ | ❌ | visible | n/a |
| Cross-file / cross-org | denied | denied | denied | denied unless separately authorized in that org/file | denied |
| AI actor mutation | denied (`ai_forbidden`) | | | | |
| Relevant server flag off | unavailable (`404`) | unavailable | unavailable | unavailable | unavailable |

## Guarantees

- Organization is resolved from `loan_files.organization_id`.
- Internal callers need active organization membership in addition to existing file access.
- Borrowers/co-borrowers need the file-specific `portal_access` grant, not organization membership.
- A specific task has a verified `responsible_user_id` and DB-derived borrower/co-borrower type.
- A shared task has `responsible_user_id IS NULL` and `shared_with_borrowers=true`.
- There is no implicit untargeted borrower-visible audience.
- Document tasks require an exact `required_document_id` on the same loan; signed upload and finalize enforce it again.
- Browser roles cannot select `loan_tasks`, `loan_events` or `loan_task_history` directly.
- Borrower responses never include internal requirement, internal reason/evidence, metadata, creator or responsible-user identifiers.
- Borrowers cannot accept/reject/complete their own task.
- Stale distinct operations write nothing; same-key/same-hash retries return the original material result; key reuse with changed material conflicts.
- Task-linked upload/finalize calls no external delivery provider; it records only an in-transaction notification intent.
- Platform-settings administration remains separate from loan-file access and does not confer task access.

Coverage is provided by `taskRepo.test.mjs`, `taskRepoRegression.test.mjs`, `orgAccess.test.mjs`, `roleVisibility.test.mjs`, `featureFlags.test.mjs`, `pendingOps.test.mjs`, `taskUi.test.mjs`, `functionalCompletionContract.test.mjs` and `sqlLifecycleParity.test.mjs`. Live database/RLS acceptance remains unrun.
