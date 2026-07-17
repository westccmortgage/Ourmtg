# OURMTG — Phase 1C Report (Operational Pilot)

## Status

- Repository: `westccmortgage/Ourmtg`
- Branch: `claude/ourmtg-phase1c-operational-pilot`
- PR: #1, base `main`, open and unmerged
- Feature flags: default off
- Migration 043: review source only, **not applied**
- Production deployment: none
- Phase 1D: not started

The authoritative functional-completion record is `OURMTG-PHASE1C-FUNCTIONAL-COMPLETION.md`. External findings remain mapped in `OURMTG-PHASE1C-EXT-RECONCILIATION.md`; the earlier self-review remains separate in `OURMTG-PHASE1C-REVIEW-FIXES.md`.

## Delivered vertical slice

```text
loan team creates and assigns a task for a verified borrower audience
→ borrower opens it (viewed)
→ borrower enters the exact document flow (in_progress)
→ signed upload is minted only for the bound document request
→ atomic finalize writes document uploaded + task submitted + history + event + intent
→ loan team sends to review
→ loan team accepts, rejects, or requests more information
→ borrower sees only the safe borrower-visible result
```

All Phase 1C task mutations pass through the server repository and service-role-only atomic RPCs. No endpoint or UI writes task state directly.

## Database and RPC design

Migration source: `docs/phase1c/migration/043_ourmtg_operational_pilot.sql`.

It defines:

- `organizations` with unique stable slug;
- `organization_members`;
- additive, backfilled, validated `loan_files.organization_id`;
- append-only `loan_events`;
- `loan_tasks` with revision, safe borrower reason, explicit audience, `required_document_id`, submitted document reference and soft archive;
- append-only `loan_task_history`;
- canonical lifecycle/event/role helper functions;
- atomic create+assign, transition, and exact-document-finalize RPCs.

The migration:

- is outside the active migration directory;
- has not been applied;
- revokes browser access to operational base tables;
- grants RPC execution only to `service_role`;
- uses `ON DELETE RESTRICT` for operational audit retention;
- performs deterministic WCC organization preflight/upsert/backfill and stops on mismatches;
- requires live isolated-branch acceptance before any promotion.

## Lifecycle

The canonical path is:

```text
created → assigned → viewed → in_progress → submitted → team_review
                                                    ↘ rejected / more_information_needed
team_review → accepted → completed
accepted / completed / rejected → reopened → assigned or in_progress
```

Create records both `created` and `assigned` atomically, ending at revision 1. A task-linked finalize is valid only from `in_progress`; it cannot skip lifecycle states.

## Audience and visibility

A borrower-facing task is exactly one of:

- targeted to one verified primary borrower;
- targeted to one verified co-borrower;
- shared with all approved borrower participants.

There is no implicit null-target audience. The DB derives borrower/co-borrower type from `portal_access`, and specific document tasks must bind to a `loan_documents` row on the same loan and appropriate participant. Borrower responses exclude internal requirement, notes, evidence, metadata, creator and responsible-user identifiers.

## Exact document binding

Document tasks require `required_document_id` at creation. The team selects the existing request. The borrower task link:

- renders only that document;
- prepares `viewed` then `in_progress` through idempotent transitions;
- requests a signed upload only for that document ID and task;
- rejects unrelated documents before storage mutation;
- finalizes only through the atomic document/task RPC.

`linked_document_id` records the submitted result; it does not replace the immutable requirement binding.

## Idempotency and concurrency

Create, transition and finalize use:

- mandatory idempotency keys;
- canonical material request hashes;
- explicit expected revision;
- unique organization/key constraint;
- duplicate-result lookup returning the original task/status/revision/document result;
- row locking and stale-revision rejection;
- deterministic notification-intent keys.

The client persists pending operation key, material payload and expected revision in local storage. Ambiguous failures and refresh recovery reuse the original operation; definitive responses clear it.

## Notification boundary

Phase 1C task operations record only minimal `notification.queued` intent events inside the authoritative transaction. The task-linked path does not call email, SMS, push or webhook providers. The older task-less document-upload path retains its pre-existing email behavior and is explicitly separate from the task pilot.

## Endpoints and UI

Added/extended server paths:

- `portal-task-list`
- `portal-task-detail`
- `portal-task-create`
- `portal-task-transition`
- task-aware `portal-doc-upload-url`
- task-aware `portal-doc-complete`
- participant-aware `portal-file-detail`
- document-ID-aware `portal-checklist`

Borrower UI shows real participant-scoped tasks, localized EN/ES/RU task state/action framing, safe reasons and only the required document. Team UI loads participants/documents, creates exact bound tasks and renders only lifecycle-valid actions.

## Feature flags

- Server: `FF_TASK_PILOT`, `FF_LOAN_TEAM_TASK_PILOT`
- Client: corresponding `VITE_FF_*` presentation flags

Server flags fail closed. Client flags never authorize backend behavior. All defaults remain off.

## QA

GitHub Actions passed:

- `npm ci`
- `npm run check`
- `npm test` — **206/206**
- `npm run build`

The suite includes existing Phase 0/1A/1B/EXT coverage plus final lifecycle, exact-document, participant, persistent-operation, UI-action, no-send and SQL/JS parity tests. Tests use pure modules and injected fake adapters; they are not represented as live database evidence.

Static mobile review found no new fixed-width/nowrap task controls and existing buttons retain mobile wrapping/tap behavior. A real-device run remains a production-readiness dependency.

## Remaining blockers

1. Migration 043 independent review.
2. Approved isolated Supabase branch and apply/rollback plan.
3. Live SQL/RLS/RPC privilege, concurrency, idempotency and backfill acceptance.
4. Preview environment with separate team/borrower/co-borrower identities and both pilot flags.
5. Real mobile browser validation.
6. Existing npm audit advisories remain unresolved.
7. Independent PR review and explicit merge/deploy approval.

## Rollback

Code is cumulative on the feature branch and flags remain off. The final functional work can be reverted to `0d73dac`; backup branch `backup/phase1c-3c3f81b` preserves the prior intermediate tree. There is no database rollback to perform because migration 043 has not been applied.

Do not merge, deploy, apply migration 043, enable flags, or begin Phase 1D without separate approval.
