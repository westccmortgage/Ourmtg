# OURMTG — Task Pilot Acceptance Plan

**Status: NOT RUN. Do not run against production.**

This document is the live-database/preview acceptance plan for `docs/phase1c/migration/043_ourmtg_operational_pilot.sql`. The migration remains unapplied. Unit, source-contract and fake-adapter tests are not a substitute for these checks.

## Prerequisites

- owner-approved isolated Supabase branch based on the current project schema;
- migrations 036–039 already present;
- two borrower identities on one file plus one borrower on another file;
- one team identity that is an active member of the target organization;
- preview-only Netlify environment pointed to that branch;
- preview server flags `FF_TASK_PILOT=1`, `FF_LOAN_TEAM_TASK_PILOT=1`;
- matching client presentation flags only in the preview;
- rollback/export plan approved before application.

Do not use production credentials or data.

## 1. Migration preflight and apply

Review the SQL, then apply it to the isolated branch only. The migration itself performs:

- unique-slug conflict preflight;
- deterministic WCC organization upsert;
- file organization backfill;
- owner membership backfill;
- organization-scoped validation;
- `loan_files.organization_id NOT NULL` only after validation.

Verify:

```sql
select count(*) from information_schema.tables
where table_schema='public'
  and table_name in ('organizations','organization_members','loan_events','loan_tasks','loan_task_history');
-- expect 5

select count(*) from public.loan_files where organization_id is null;
-- expect 0

select count(*) from public.organizations where slug='west-coast-capital-mortgage';
-- expect 1

select count(*) from public.loan_files lf
where not exists (
  select 1 from public.organization_members m
  where m.organization_id=lf.organization_id
    and m.user_id=lf.owner_user_id
    and m.status='active'
);
-- expect 0
```

Re-running the migration in a fresh reset of the same branch must not create another organization or membership.

## 2. Privilege and RLS acceptance

```sql
select has_table_privilege('authenticated','public.loan_tasks','SELECT');        -- false
select has_table_privilege('authenticated','public.loan_events','SELECT');       -- false
select has_table_privilege('authenticated','public.loan_task_history','SELECT'); -- false
select has_table_privilege('anon','public.loan_tasks','SELECT');                 -- false

select has_function_privilege(
  'authenticated',
  'public.ourmtg_task_transition(uuid,text,integer,text,uuid,uuid,text,text,jsonb,text,text,text,text,timestamptz)',
  'EXECUTE'
); -- false

select has_function_privilege(
  'service_role',
  'public.ourmtg_document_finalize_submit(uuid,uuid,uuid,uuid,text,integer,text,text,text,text,timestamptz)',
  'EXECUTE'
); -- true
```

Using a real borrower JWT, direct PostgREST reads of `loan_tasks`, `loan_events` and `loan_task_history` must fail. The Netlify gateway task-list/detail endpoints must still return the approved scrubbed fields.

## 3. Create + assign atomicity

Select:

- `:org` — target organization ID;
- `:file` — loan file in that organization;
- `:lo_user` — active organization member and authorized file owner/team user;
- `:borrower_user` — borrower portal participant;
- `:doc` — existing requested `loan_documents` row on `:file`, matching the participant.

Call with the current function signature from a service-role session:

```sql
select public.ourmtg_task_create(
  :org,
  :file,
  'document_request',
  'Upload your June bank statement',
  'Please include every page.',
  'UW: latest consecutive statement, all pages',
  :borrower_user,
  false,
  'normal',
  true,
  null,
  :doc,
  'bank_statement',
  :lo_user,
  'loan_officer',
  :lo_user,
  'ourmtg',
  'corr-create-1',
  'idem-create-1',
  'hash-create-1',
  now()
);
```

Expected:

- response contains one `task_id`, `status=assigned`, `revision=1`;
- one task row;
- two history rows: `null→created`, `created→assigned`;
- one `task.created` and one `task.assigned` event;
- one `notification.queued` intent;
- no provider delivery.

Repeat with the same key/hash: original task/status/revision, no new rows. Repeat with the same key/different hash: `idempotency_conflict`, no new rows.

Deliberately fail the history/event/intent insert on a disposable transaction and prove the task row does not remain.

## 4. Audience and exact document validation

Create separate tasks for:

- the primary borrower;
- the co-borrower;
- shared with all approved borrowers.

Verify:

- DB derives `responsible_party_type` from `portal_access`;
- arbitrary user ID → `participant_invalid`;
- co-borrower target with primary-borrower document → `participant_invalid`;
- document from another loan → `document_binding_mismatch`;
- document task without `required_document_id` → `required_document_missing`;
- shared + specific user simultaneously → `audience_invalid`;
- participant-specific list/detail visibility is isolated; shared task is visible to both.

## 5. Lifecycle and revision acceptance

Starting from the newly assigned task:

```text
assigned (revision 1)
→ view (borrower, expected 1)
→ viewed (revision 2)
→ begin (borrower, expected 2)
→ in_progress (revision 3)
```

Use the transition RPC with a stable idempotency key/hash for each operation. Confirm one task update, one history row and one event per transition.

A different key using an old revision must return `stale_task` with zero writes. A same-key retry after the first response was lost must return the original `from`, `to` and `revision` without another history/event/intent.

Confirm the SQL graph matches the application graph and specifically rejects:

- `created→submitted`;
- `assigned→submitted`;
- `rejected→rejected`;
- `team_review→reopen`.

## 6. Exact signed upload and atomic finalize

From a borrower preview session on an `in_progress` task:

1. request signed upload using task ID plus the task’s exact `required_document_id`;
2. verify another document ID is rejected before a new storage path is recorded;
3. upload the object;
4. finalize with task ID, expected revision and one stable idempotency key.

Expected in one RPC transaction:

- exact document status becomes `uploaded`;
- task becomes `submitted` and revision increments;
- `linked_document_id` equals `required_document_id`;
- one history row;
- one `task.submitted` event;
- one minimal loan-team intent;
- no email/SMS/push/webhook call on the task path.

Test deliberate failures in document update, task update, history insert, event insert and intent insert; every case must leave both document and task unchanged.

Test wrong loan, wrong organization, wrong participant, wrong document, wrong revision, invalid task state and flag-off behavior.

Retry with the same key/hash after a simulated lost HTTP response. It must return the original task/document/revision and add no rows. Same key/different hash must conflict.

## 7. Team review and borrower reason

Proceed:

```text
submitted → team_review → reject
```

Reject without a borrower-visible reason must fail at gateway and RPC. Reject with a reason must persist the safe reason and one intent. Borrower response must expose the safe reason but not internal requirement, reason, evidence, metadata or actor details.

Then:

```text
rejected → in_progress → exact linked finalize → submitted
```

The safe reason must clear when the borrower re-engages. Repeat similarly for request-more-info. Reopen must appear and execute only from lifecycle-valid states and requires a safe borrower-visible reason.

## 8. Endpoint and flag matrix

With flags off:

- all task endpoints return unavailable;
- task ID supplied to upload preparation/finalize never falls back to legacy completion;
- task-less legacy document upload remains unchanged.

With flags on, test authenticated/unauthenticated, guessed ID, another borrower, realtor, escrow/title, internal user without organization membership, and cross-organization access.

## 9. Browser/mobile preview

At 360×800, 375×812, 390×844, 393×852 and 430×932:

- create a task for a specific borrower and co-borrower;
- select the exact document;
- confirm only the bound document appears in borrower task flow;
- test loading/error/empty/success states;
- test lost-response recovery without duplicate task or upload;
- test long Russian labels/reasons and no horizontal overflow;
- verify 44px action targets.

Capture screenshots and request/response evidence without exposing borrower PII.

## 10. Audit retention and rollback

Verify update/delete of event/history rows raises. Verify hard-delete of task/file/organization with operational history is restricted. Test soft archive.

Before any rollback, export audit rows. Follow a reviewed dependency-order rollback; do not erase immutable history simply to make rollback convenient.

## Exit rule

Every section must pass on the isolated branch before production-readiness may be considered. Even a successful branch acceptance does not authorize merge or production deployment; those require independent PR review and explicit approval.
