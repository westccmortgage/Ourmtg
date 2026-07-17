# OURMTG — Phase 1C Data Migration Review

**Source:** `docs/phase1c/migration/043_ourmtg_operational_pilot.sql`

**Status:** reviewable, runnable only on an explicitly approved isolated Supabase branch, and **NOT APPLIED**. It is intentionally outside `supabase/migrations/` and therefore cannot be auto-applied by the existing migration sequence.

## Scope

The minimum pilot schema contains:

- `organizations` with unique stable `slug` and soft archive;
- `organization_members`;
- additive `loan_files.organization_id`, deterministically backfilled and validated;
- append-only `loan_events` with organization-scoped idempotency and request hashes;
- `loan_tasks` with explicit audience, revision, safe borrower reason, exact required document, submitted document and soft archive;
- append-only `loan_task_history`;
- canonical lifecycle/event/role helper functions;
- three service-role-only RPCs:
  - `ourmtg_task_create` — atomically records created + assigned + intent;
  - `ourmtg_task_transition` — authoritative lifecycle transition;
  - `ourmtg_document_finalize_submit` — exact-document upload finalization + task submission.

Cash-to-close persistence, disclosures, milestones, third-party orders, external notification delivery and AI actions are not promoted by migration 043.

## Existing-schema reconciliation

The migration references existing:

- `loan_files`;
- `loan_documents`;
- `loan_conditions`;
- `portal_access`;
- `auth.users`;
- `set_updated_at()` from migration 036.

It does not delete or rewrite existing portal, invite, consent, condition, document, message, CRM or storage records.

## Deterministic organization backfill

The migration performs the following sequence, and stops on conflict:

1. preflight: reject a West Coast Capital Mortgage display-name collision under another slug;
2. upsert `west-coast-capital-mortgage` using the unique slug;
3. assign currently unassigned loan files to that organization;
4. create/reactivate owner memberships in the same organization;
5. validate that every loan file belongs to the target organization;
6. validate that each file owner is an active member of that exact organization;
7. set `loan_files.organization_id` non-null only after validation.

This is deliberately single-organization pilot backfill logic. A future multi-organization migration must provide an explicit source mapping rather than reuse the single-org assignment.

## Task audience and document constraints

Borrower-facing tasks obey a schema constraint:

- shared task → `responsible_user_id IS NULL`;
- specific task → verified non-null `responsible_user_id`;
- internal task → not shared.

The create RPC derives `responsible_party_type` from the participant’s actual `portal_access.visibility`; the client cannot declare a primary borrower or co-borrower type.

Document request/re-upload/missing-page tasks require `required_document_id`. The RPC verifies the document exists on the same loan and, for specific participants, that its `who` matches borrower/co-borrower visibility. `linked_document_id` remains a distinct submitted-result reference.

## Lifecycle and concurrency

The SQL transition graph is parity-tested against the functions-local and Phase 1B domain graph.

- Create records `created` then `assigned` atomically and stores revision 1.
- Transition RPC accepts an action and expected revision, locks the task, checks the stored revision, derives the next state/event and rejects invalid/stale operations.
- Finalize accepts only `in_progress` and the exact `required_document_id`.
- Reject, request-more-info and reopen require a borrower-visible reason in the RPC.
- Duplicate key + same request hash returns the original material result.
- Duplicate key + different hash raises `idempotency_conflict`.
- A unique-key race rolls back the losing attempted writes and returns the already committed result when the hashes match.

## Atomic writes

Successful create writes, in one transaction:

- task ending `assigned`;
- `created` and `assigned` history rows;
- `task.created` and `task.assigned` events;
- one minimal borrower notification intent.

Successful transition writes, in one transaction:

- updated task and revision;
- one history row;
- one domain event;
- a minimal intent only when required.

Successful linked finalize writes, in one transaction:

- document `uploaded`;
- task `submitted` and submitted document link;
- one history row;
- one domain event;
- one minimal loan-team intent.

Any validation, constraint, history, event or intent failure rolls back the whole RPC.

## Privileges and retention

- Operational base-table access is revoked from `anon` and `authenticated`.
- Borrower task reads go through the authenticated Netlify gateway.
- Every operational RPC uses a fixed `search_path` and execution is revoked from `PUBLIC`, `anon` and `authenticated`; only `service_role` receives execute.
- `loan_events` and `loan_task_history` reject update/delete.
- Organization/file/task audit relationships use `ON DELETE RESTRICT` or controlled nulling where actor/source references may be removed.
- Tasks and organizations expose archive timestamps rather than silent cascading deletion.

## Acceptance requirements before promotion

Migration 043 has **not** been run. Before it may be copied into the active migration sequence, an approved isolated branch must verify:

1. preflight/upsert/backfill and `NOT NULL` conversion;
2. table and RPC privileges for anon/authenticated/service role;
3. direct borrower base-table denial;
4. append-only and delete-restrict behavior;
5. create+assign history/event/intent counts;
6. stale concurrent writers;
7. same-key concurrency and material-result replay;
8. exact participant/document binding;
9. full atomic rollback on deliberate history/event/intent failures;
10. rollback/recovery procedure.

The authored commands are in `OURMTG-TASK-PILOT-ACCEPTANCE.md`. Fake-adapter tests and source-contract tests are useful code evidence, but are not live database evidence.

## Rollback posture

No database rollback is currently required because the migration remains unapplied. A future approved branch apply must export/retain operational audit data and use a reviewed dependency-order rollback; it must not hard-delete audit history merely to simplify rollback.
