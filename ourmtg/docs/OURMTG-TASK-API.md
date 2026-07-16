# OURMTG — Task API (Phase 1C pilot)

Authenticated Netlify Functions (Supabase JWT Bearer). Service-role work is gated in code by
`resolveAccess` + org membership; no raw table CRUD is exposed. All responses `Cache-Control: no-store`.

## `GET portal-task-list?loanFileId=<id>`
Lists tasks for a loan file. Internal (owner/team) → full rows. Borrower/co-borrower → their
borrower-facing tasks only, **field-scoped** (no `internal_requirement`, notes, evidence, created_by,
responsible_user_id). Realtor/escrow/title → `403`. → `{ ok, view:'team'|'borrower', tasks[] }`.

## `GET portal-task-detail?taskId=<id>`
One task. Internal → task + `history[]`. Borrower → scrubbed task, no history. Cross-org → `403`.

## `POST portal-task-create`  (internal only)
Body: `{ loanFileId, title, borrowerExplanation?, internalRequirement?, dueAt?, isBlocking?, requiredDocumentType?, taskType?, priority?, idempotencyKey? }`.
`dueAt` is validated (400 on a bad date). A client `idempotencyKey` makes a retried submit create
**one** task; a duplicate returns the same `taskId` (never a second insert). Creates atomically
(task + history `created` + event `task.created`) and records a best-effort borrower
notification-intent (only on a fresh create). → `{ ok, taskId }`.

## `POST portal-task-transition`
Body: `{ taskId, action, reason?, evidence?, idempotencyKey? }`.
`action ∈ assign | view | begin | submit | precheck | sendToTeamReview | accept | reject |
requestMoreInfo | complete | reopen | cancel`. Validation is the canonical pure task service;
persistence is the atomic RPC. `reject` requires a borrower-visible `reason` (≥3 chars).
`evidence` is accepted **only from internal (team) actors** and only under a size cap
(borrower-supplied evidence is ignored). `linkedDocumentId` is **server-set only** (via
`portal-doc-complete`) — it is not accepted from this body (prevents linking an arbitrary
document to a task). Idempotency key defaults to `(task, action, pre-state, updated_at)` so a
legitimate repeat after a reopen cycle is not falsely deduped; a true double-submit collides.
→ `{ ok, from, to, deduped? }`.

Error → HTTP: `unknown_action`→400 · `invalid_transition`/`review_required`→409 ·
`forbidden_action`/`forbidden_role`/`ai_forbidden`→403 · `persist_failed`→500 · not found→404.

## Document linking — `POST portal-doc-complete` (extended)
Body adds optional `taskId`. After the document is finalized (`status='uploaded'`), if `taskId`
belongs to the same file+org and is a borrower task, it transitions to `submitted` and links the
document. An upload/finalize failure returns before this — the task never moves. → `{ ok, documentId, status, taskTransition? }`.

## Borrower may / may not
May: list visible tasks, view a permitted task, `view`, `begin`, `submit`, upload linked documents.
May not: create/assign tasks, `accept`/`reject`, complete review-required tasks, see
`internal_requirement`/internal evidence/notes. Realtor/escrow/title: no financial/document tasks.
Team: create, assign, review, accept, reject, request-more-info, complete, reopen, cancel (own files).
Admin authority (site settings) is separate from loan/task access.
