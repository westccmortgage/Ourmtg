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

## Fail-closed single-organization backfill (M2)

The backfill is **fail-closed** and never silently claims a `NULL` row. It never infers organization
from an email domain. The sequence is:

1. **identity preflight** — reject a WCC legal/display-name collision under another slug;
2. **deterministic upsert** of `west-coast-capital-mortgage` by unique slug;
3. **preflight inventory + gate** — emit `RAISE NOTICE` counts (total loan files; distinct
   `owner_user_id`; distinct existing `organization_id`; files assigned to another org; files with a
   null owner; target org count by slug; conflicting-identity orgs; owners without target membership),
   then **REFUSE** (raise `backfill_refused`) if any of: more than one WCC target org exists; a
   conflicting identity exists under another slug; **any loan file already belongs to another
   organization** (→ requires an explicit multi-org mapping); or **any loan file has a null owner**
   (ambiguous — membership cannot be safely created);
4. **operator-approved assignment** — only after the gate passes (dataset proven to be an unambiguous
   single-org WCC pilot) are the remaining unassigned files set to WCC, and owner memberships created;
5. **post-backfill validation** — report zero unmatched rows (`files_not_in_target_org=0`,
   `owners_without_membership=0`) before `SET NOT NULL`; otherwise raise `backfill_incomplete`.

A future **multi-organization** dataset is explicitly refused by step 3 and must instead supply a
reviewed `loan_file_id → organization_id` mapping (never automatic `NULL ⇒ WCC`).

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

No database rollback is currently required because the migration remains unapplied. The reviewed,
dependency-ordered rollback companion is **`043_ourmtg_operational_pilot.rollback.sql`** (review source
only; it hard-guards against execution and keeps every destructive `DROP`/`ALTER` commented). It covers:
a safety guard + environment warning, a pilot-flags-disabled checklist, pre-rollback inventory counts,
export/snapshot instructions for `loan_events` / `loan_task_history` / `loan_tasks` /
`organization_members` / `organizations` / affected `loan_files`, an explicit decision gate before
deleting immutable audit evidence, the reverse dependency order (RPCs → helpers → history → tasks →
events → memberships → `loan_files.organization_id` FK/index/column → organizations → immutable trigger
fn), `ON DELETE RESTRICT` handling (drop referencing tables first; never `CASCADE`), post-rollback
validation, and the distinction between a disposable isolated-branch rollback and a production
retention/decommission (which must export/retain audit data — never silently delete it). The rollback
has **not** been executed.
