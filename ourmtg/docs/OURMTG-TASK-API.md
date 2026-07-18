# OURMTG — Task API (Phase 1C)

All task APIs are authenticated Netlify Functions. Organization comes from `loan_files.organization_id`; internal actors also need active membership in that organization, while borrower/co-borrower access comes from the file-specific `portal_access` grant.

Operational tables are not directly selectable by browser roles. Authoritative mutations use service-role-only RPCs. Sensitive responses are `Cache-Control: no-store`.

## Feature gates

- Borrower task reads/actions and task-linked upload: `FF_TASK_PILOT`
- Team task create/review: `FF_LOAN_TEAM_TASK_PILOT`

The server flags fail closed. `VITE_FF_*` controls presentation only.

## Request hardening

Phase 1C POST handlers require JSON, size-cap the raw body, reject malformed/non-object JSON and dangerous prototype keys, validate UUIDs/enums/timestamps/lengths, and return safe generic transport/database errors.

## `GET portal-task-list?loanFileId=<uuid>`

Internal caller:

- full task rows for one authorized file and organization.

Borrower/co-borrower:

- only shared tasks or tasks targeted to the authenticated participant;
- safe borrower fields only;
- no internal requirement, internal reason/evidence, metadata, creator or responsible-user identifier.

Realtor/escrow/title and cross-organization callers are denied.

## `GET portal-task-detail?taskId=<uuid>`

Internal caller receives task plus history. Borrower receives a scrubbed task only when they are an approved participant and the task is shared or specifically targeted to them.

Borrower-safe task data includes:

- title and explanation;
- status and revision;
- due date/priority/blocking;
- safe borrower-visible status reason;
- exact `required_document_id`;
- submitted `linked_document_id` when present.

## `POST portal-task-create`

Internal-only; requires `FF_LOAN_TEAM_TASK_PILOT`.

Material body:

```json
{
  "loanFileId": "uuid",
  "taskType": "document_request",
  "title": "Upload your June business bank statement",
  "borrowerExplanation": "Please include every page.",
  "internalRequirement": "UW: two consecutive months, all pages",
  "responsibleUserId": "uuid or null",
  "sharedWithBorrowers": false,
  "requiredDocumentId": "uuid",
  "requiredDocumentType": "business_bank_statement",
  "dueAt": "ISO timestamp or null",
  "priority": "normal",
  "isBlocking": true,
  "idempotencyKey": "stable client operation key"
}
```

Rules:

- specific task: verified participant ID, `sharedWithBorrowers=false`;
- shared task: `responsibleUserId=null`, `sharedWithBorrowers=true`;
- participant type is derived from `portal_access`;
- document tasks require the exact existing `loan_documents.id` on the same loan;
- specific participant’s document `who` must match their borrower/co-borrower visibility;
- idempotency key is mandatory and bound to a canonical material request hash.

The RPC atomically records:

- task ending `assigned`, revision 1;
- history: `null→created`, `created→assigned`;
- events: `task.created`, `task.assigned`;
- one minimal `notification.queued` intent.

Response:

```json
{ "ok": true, "taskId": "uuid", "status": "assigned", "revision": 1, "deduped": false }
```

A valid retry returns the original task/status/revision. Same key with changed material returns `409 idempotency_conflict`.

## `POST portal-task-transition`

Borrower actions require `FF_TASK_PILOT`; internal actions require `FF_LOAN_TEAM_TASK_PILOT`.

```json
{
  "taskId": "uuid",
  "action": "view|begin|submit|precheck|sendToTeamReview|accept|reject|requestMoreInfo|complete|reopen|cancel|assign",
  "expectedRevision": 3,
  "idempotencyKey": "stable client operation key",
  "borrowerVisibleReason": "required for reject, requestMoreInfo, and reopen",
  "reason": "optional internal reason",
  "evidence": { "teamOnly": "bounded object" }
}
```

The endpoint verifies access and audience, then the repository invokes the atomic RPC. The RPC:

1. checks key/hash and returns original material result on a duplicate;
2. locks the task;
3. verifies file organization and actor relationship;
4. compares expected revision;
5. derives and validates the canonical next state/event;
6. requires a borrower-visible reason where applicable;
7. updates task, history, event and optional intent in one transaction.

Response:

```json
{ "ok": true, "taskId": "uuid", "from": "submitted", "to": "team_review", "revision": 5, "deduped": false }
```

Domain errors remain distinguishable from `persist_failed`. A stale distinct operation writes nothing; a same-key retry returns the original result.

## Task-linked upload preparation: `POST portal-doc-upload-url`

Legacy body remains `{ loanFileId, docKey }`.

Task-linked body adds:

```json
{
  "loanFileId": "uuid",
  "docKey": "business_bank_statement",
  "taskId": "uuid",
  "documentId": "the task required_document_id",
  "filename": "statement.pdf",
  "contentType": "application/pdf"
}
```

When `taskId` is supplied:

- pilot flag must be on;
- task must exist, be participant-visible and `in_progress`;
- `documentId` and `docKey` must identify the exact bound document request;
- another document cannot receive a signed task upload URL;
- invalid/missing task context never falls back to legacy behavior.

## Task-linked finalize: `POST portal-doc-complete`

Legacy body remains `{ documentId }` and preserves the pre-existing task-less email behavior.

Task-linked body:

```json
{
  "documentId": "uuid",
  "taskId": "uuid",
  "expectedRevision": 3,
  "idempotencyKey": "stable client operation key"
}
```

The gateway validates JSON/UUIDs/flags/access, verifies the private storage object fail-closed, and invokes the atomic finalize RPC. The RPC requires:

- task status `in_progress`;
- exact `required_document_id`;
- same loan and organization;
- actor’s matching borrower/co-borrower grant;
- shared or exact participant audience;
- expected revision and idempotency hash.

One successful transaction writes document uploaded, task submitted, history, event and one minimal loan-team intent. The task-linked path calls no delivery provider. A duplicate returns the original task/document/revision result.

## Client retry contract

The browser persists pending create, transition and finalize operations before sending:

- idempotency key;
- material payload;
- expected revision;
- task/document identity.

Double-click, ambiguous failure and refresh recovery reuse the original operation. Definitive success/client rejection clears it. A lost finalize response retries finalize before attempting a second upload.

## Lifecycle

```text
create RPC: created → assigned
borrower: assigned → viewed → in_progress
linked finalize: in_progress → submitted
team: submitted → team_review → accepted|rejected|more_information_needed
accepted → completed
accepted|completed|rejected → reopened
reopened → assigned|in_progress
```

The SQL graph is tested for parity with the server/domain graph. Finalize cannot bypass lifecycle states.
