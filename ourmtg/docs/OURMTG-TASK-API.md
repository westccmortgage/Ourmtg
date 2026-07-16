# OURMTG — Task API (Phase 1C pilot, external-review hardened)

Authenticated Netlify Functions (Supabase JWT Bearer). Org is resolved from the **loan file**
(`loan_files.organization_id`, EXT-1); internal callers must be **active members** of that org,
borrowers/co-borrowers ride `portal_access` (no membership). No raw table CRUD is exposed — the base
operational tables are not selectable by `anon`/`authenticated` (EXT-2); persistence goes through
`service_role`-only SECURITY DEFINER RPCs (EXT-3). All responses `Cache-Control: no-store`.

Every endpoint is gated by a **fail-closed server flag** (EXT-10): `FF_TASK_PILOT` for borrower
list/detail/transition + task-linked upload; `FF_LOAN_TEAM_TASK_PILOT` for team create/review. When
the relevant flag is unset the endpoint returns `404`. `VITE_FF_*` is presentation-only and authorizes
nothing.

Every POST is hardened (EXT-11): JSON content-type required (`415`), size-capped (`413`), empty/invalid
JSON rejected (`400`), arrays/non-objects rejected, and any payload containing `__proto__` /
`constructor` / `prototype` keys rejected (`400`). UUIDs, enums, timestamps and string bounds are
validated; client errors are generic and logs are PII-safe.

## `GET portal-task-list?loanFileId=<id>`
Lists tasks for a loan file. Internal (owner/team, member of the file's org) → full rows. Borrower/
co-borrower → their **participant-scoped** borrower-facing tasks only (EXT-7: shared, targeted to them,
or untargeted — never a task targeted to another borrower), **field-scoped** (no `internal_requirement`,
notes, evidence, `created_by`, `responsible_user_id`; `borrower_visible_status_reason` **is** included).
Realtor/escrow/title → `403`. Unprovisioned file (no org) → `503`. → `{ ok, view:'team'|'borrower', tasks[] }`.

## `GET portal-task-detail?taskId=<id>`
One task. Internal → task + `history[]`. Borrower → scrubbed task (EXT-6 reason included), no history,
and only if the borrower is a participant of that task (EXT-7). Cross-org → `403`.

## `POST portal-task-create`  (internal only; `FF_LOAN_TEAM_TASK_PILOT`)
Body: `{ loanFileId, title, idempotencyKey, borrowerExplanation?, internalRequirement?, dueAt?,
isBlocking?, requiredDocumentType?, taskType?, priority?, sharedWithBorrowers?, responsibleUserId? }`.

- **`idempotencyKey` is MANDATORY** (EXT-8): `^[A-Za-z0-9_.:-]{8,200}$`; there is no random server
  fallback. The server also computes a canonical **request hash** of the material payload. Same key +
  same payload → the original `taskId` (`deduped:true`); same key + different payload →
  `idempotency_conflict` (`409`).
- **Participant selection is required** (EXT-7): `sharedWithBorrowers:true` **or** a valid
  `responsibleUserId` (UUID). Neither → `400`. When `responsibleUserId` is given it must be a **verified
  borrower/co-borrower** on this loan file (checked against `portal_access`, FCG #2) — an arbitrary or
  cross-file user id is rejected `400`.
- `dueAt` validated (`400` on a bad date). Creates atomically (task + history `created` + event
  `task.created`) and writes the borrower notification **intent in the same transaction**, keyed
  `intent:<idempotencyKey>` (EXT-9 — no send here). → `{ ok, taskId, deduped? }`.

## `POST portal-task-transition`  (`FF_TASK_PILOT` for borrowers · `FF_LOAN_TEAM_TASK_PILOT` for team)
Body: `{ taskId, action, idempotencyKey, expectedRevision?, reason?, borrowerVisibleReason?, evidence? }`.
`action ∈ assign | view | begin | submit | precheck | sendToTeamReview | accept | reject |
requestMoreInfo | complete | reopen | cancel`.

- Validation is the canonical pure task service (fast-fail); the **RPC is authoritative**: it locks the
  row `FOR UPDATE`, checks `expectedRevision` against the stored `revision` (EXT-4 →
  `stale_task` on mismatch), re-validates the transition graph, **derives** the to-status and event type
  itself (the caller never supplies a status or event), bumps `revision`, and writes task + history +
  event atomically.
- `reject` / `requestMoreInfo` require a **borrower-visible reason** (`borrowerVisibleReason`, ≥3 chars,
  EXT-6). The reason is stored on the task, returned to the borrower, and **cleared** when the borrower
  resubmits or the item is accepted/completed. `reason` is a separate internal (private) note. This is
  enforced at the gateway **and** re-enforced by the RPC (`reason_required`), so the rule holds even if a
  caller reaches the RPC directly (FCG-2.5, defense-in-depth).
- `evidence` is accepted **only from internal (team) actors** and only under a size cap.
- **`idempotencyKey` is MANDATORY** and bound to `{taskId, action, expectedRevision, actor, reason,
  borrowerVisibleReason, evidence}` (EXT-8). `linkedDocumentId` is **not** accepted here — document
  linking happens only in `portal-doc-complete`.
- A reject / more-info also writes the borrower notification **intent in the same transaction** (EXT-9).
→ `{ ok, from, to, revision, deduped? }`.

Error → HTTP: `unknown_action`/`reason_required`→400 · `invalid_transition`/`review_required`/
`stale_task`/`idempotency_conflict`→409 · `forbidden_action`/`forbidden_role`/`ai_forbidden`→403 ·
`persist_failed`→500 · not found→404.

## Document linking — `POST portal-doc-complete` (extended; `FF_TASK_PILOT`)
Body adds optional `taskId`. Storage existence is verified **fail-closed** first (a storage list error
returns `502` — it is never treated as permission to proceed).

**No legacy fallback once `taskId` is supplied (FCG #6):** the route is decided purely from `taskId` +
flag — no `taskId` → the legacy document-only flip; a supplied `taskId` that is a bad UUID → `400`; a
supplied `taskId` with the pilot flag off → `404` (**never** a silent legacy flip); a supplied valid
`taskId` with the flag on → the task path.

On the task path, one **atomic RPC** (`ourmtg_document_finalize_submit`, EXT-5 / FCG #1/#3/#7) validates
document/task/loan/org, the acting borrower is the **targeted participant** (`not_participant` otherwise),
and the **exact document binding** (a task already linked to one document rejects a different one with
`document_binding_mismatch`); it accepts any borrower-actionable pre-submission state
(`created|assigned|viewed|in_progress|rejected|more_information_needed|reopened` — the borrower's single
submit action, so the lifecycle is executable end-to-end), then marks the document `uploaded`, links it,
transitions the task to `submitted`, and appends history + event — **all-or-nothing**. Any failure rolls
back both the document and the task; the endpoint never reports `ok` after a partial failure.
→ `{ ok, documentId, status, taskTransition? }`.

## Borrower may / may not
May: list **participant-visible** tasks, view a permitted task, `view`, `begin`, `submit`, upload linked
documents. May not: create/assign tasks, `accept`/`reject`, complete review-required tasks, see
`internal_requirement`/internal evidence/notes, or act on a task targeted to another borrower.
Realtor/escrow/title: no financial/document tasks. Team: create, assign, review, accept, reject,
request-more-info, complete, reopen, cancel (own files, as an org member). Admin authority (site
settings) is separate from loan/task access.
