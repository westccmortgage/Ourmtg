# OURMTG — Phase 1C Architecture

Phase 1C adds one flag-gated operational vertical slice to the existing Vite/React, Netlify Functions and Supabase application. Migration 043 is review source only and remains unapplied.

## End-to-end slice

```text
TEAM
portal-file-detail → authorized participants + existing document requests
portal-task-create → atomic create + assign RPC

BORROWER
portal-task-list/detail → participant-scoped, field-scrubbed task
Documents task route → idempotent viewed → in_progress
portal-doc-upload-url → exact task + exact required document + signed private upload
portal-doc-complete → atomic document uploaded + task submitted + history + event + intent

TEAM
portal-task-transition → team_review → accept / reject / more-information / complete / reopen
```

Every authoritative mutation uses `taskRepo` and one service-role-only RPC. UI and endpoint code never performs direct task-state writes.

## Layers

```text
docs/phase1c/migration/043_ourmtg_operational_pilot.sql
  organizations / organization_members
  loan_files.organization_id
  loan_events / loan_tasks / loan_task_history
  canonical lifecycle helpers
  create+assign / transition / document-finalize RPCs

netlify/functions/_lib/
  orgAccess.mjs       loan-scoped org + participant/document verification
  featureFlags.mjs    fail-closed backend gates
  idempotency.mjs     canonical material request hashes
  requestGuard.mjs    JSON/size/UUID/prototype-pollution validation
  taskLifecycle.mjs   functions-local Phase 1B lifecycle mirror
  taskRepo.mjs        field scope + repository/RPC boundary

netlify/functions/
  portal-task-list/detail/create/transition
  portal-doc-upload-url / portal-doc-complete
  portal-file-detail / portal-checklist

src/lib/
  api.js              task-aware API and upload context
  pendingOps.js       persistent client operations
  taskUi.js           lifecycle-valid UI actions/preparation
  taskLabels.js       EN/ES/RU borrower task labels

src/components + pages
  NeedsAttention
  TeamTaskCard
  BorrowerDashboard
  LoanFileDetail
  Documents
```

## Lifecycle

The SQL graph is parity-tested against `_lib/taskLifecycle.mjs` and the Phase 1B domain graph.

- Create records `created` and `assigned` atomically; the stored task ends `assigned`, revision 1.
- Borrower opens a task: `assigned → viewed`.
- Borrower enters the upload workflow: `viewed → in_progress`.
- Atomic document finalize allows only `in_progress → submitted`.
- Team review: `submitted → team_review → accepted|rejected|more_information_needed`.
- Correction paths re-enter `in_progress` before another finalize.
- Invalid or stale transitions create no task/history/event/intent writes.

## Organization and access boundary

- Organization comes from `loan_files.organization_id`.
- Internal users need active membership in that organization in addition to file access.
- Borrowers/co-borrowers use the loan-specific `portal_access` grant and do not need organization membership.
- Realtor/escrow/title cannot read or mutate financial/document tasks.
- RPCs revalidate organization, actor membership/participant, file and task relationships inside the transaction.
- Browser roles cannot select operational base tables or execute operational RPCs directly.

## Audience model

A borrower task is either:

- specific to a verified primary borrower;
- specific to a verified co-borrower;
- shared with all approved borrower participants.

Specific audience type is derived from `portal_access`, not trusted from the client. Null-target/non-shared tasks are rejected by schema and RPC rules.

## Exact document requirement

Document tasks require `required_document_id`, referencing one existing `loan_documents` row on the same loan. The team selects this row when creating the task. Signed upload preparation and finalization both verify:

- task and document belong to the same loan and organization;
- borrower can see/act on the task;
- task is `in_progress`;
- document ID equals `required_document_id`.

Only the bound document is rendered on the borrower task route. `linked_document_id` records the submitted result separately.

## Atomicity, idempotency and audit

The RPC sequence is:

1. check canonical idempotency key and request hash;
2. return the original material result on a valid duplicate;
3. lock relevant rows;
4. validate organization, participant, revision, state, reason and document binding;
5. update current state;
6. append task history;
7. append domain event;
8. append minimal notification intent when required;
9. commit all or roll back all.

`loan_events` and `loan_task_history` are append-only. Operational foreign keys use restrict/no-action semantics and tasks support soft archive.

The browser persists pending create/transition/finalize operations through ambiguous failures and refresh. Retries reuse the original key, payload and expected revision.

## Notification boundary

Task operations are intent-only. The task-linked path records minimal `notification.queued` events and invokes no delivery provider. Existing task-less document upload emails remain a separate legacy path and were not introduced or expanded by Phase 1C.

## Feature flags

- Server authorization: `FF_TASK_PILOT`, `FF_LOAN_TEAM_TASK_PILOT`
- Client presentation: corresponding `VITE_FF_*`

Missing or malformed server flags mean disabled. All defaults remain off.

## Verification status

- `npm run check` — PASS
- `npm test` — **206/206 PASS**
- `npm run build` — PASS
- SQL/JS lifecycle parity — automated PASS
- Migration 043 live application — NOT RUN
- Live RLS/RPC/concurrency/backfill acceptance — NOT RUN
- Real-device preview validation — NOT RUN

Code completion is independently reviewable. Production readiness remains blocked until the unapplied migration and environment-level acceptance are separately approved and completed.
