# OURMTG — Phase 1C Data Migration (Rev 2, external-review hardened)

**File:** `docs/phase1c/migration/043_ourmtg_operational_pilot.sql` — production-shaped, **NOT
APPLIED**, and intentionally OUTSIDE `supabase/migrations/` so it is never auto-run. Apply to a
**Supabase branch** only, after owner approval (see `OURMTG-TASK-PILOT-ACCEPTANCE.md`). Rev 2 folds in
external-review findings EXT-1..EXT-13.

## Promoted entities (minimum for the pilot)
`organizations`, `organization_members`, `loan_events`, `loan_tasks`, `loan_task_history`; an additive
`loan_files.organization_id` column (EXT-1); and **three** `service_role`-only SECURITY DEFINER RPCs:
`ourmtg_task_create`, `ourmtg_task_transition`, `ourmtg_document_finalize_submit`. Three helper
functions (`ourmtg_task_next_status`, `ourmtg_task_event_type`, `ourmtg_task_role_allows`) make the DB
the authority on the transition graph. Cash-to-close, disclosures, milestones, notifications, and
third-party tables are **not** promoted this phase.

## Reconciliation with 036–039 (does NOT alter existing objects except one additive column)
- FKs reference existing `loan_files(id)`, `loan_conditions(id)`, `loan_documents(id)`, `auth.users(id)`.
- Reuses the 036 `set_updated_at()` trigger fn for `updated_at`.
- Adds one **additive, nullable** column `loan_files.organization_id` (EXT-1) with `ON DELETE RESTRICT`;
  no existing column is changed.
- Existing `portal_users`, `portal_access`, `portal_invites`, `loan_documents`, `loan_conditions`,
  `portal_consent`, `portal_access_log`, `loan_strategy`, `app_state`, and storage policies are **untouched**.
- The Phase 0 drafts `040`/`041` (owner_user_id-only tenancy) are superseded — this pilot uses `organization_id`.

## Organization boundary (EXT-1)
The org is resolved from the **loan file** (`loan_files.organization_id`), never from the caller's
arbitrary first membership. Internal (owner/team) users must be **active members** of that org
(`organization_members`, explicit — never email-domain inferred). Borrowers/co-borrowers ride a
`portal_access` grant and require **no** membership. Users may belong to **many** orgs; resolution is
always against the file's org. Realtor/escrow/title are denied.

## Access & privilege lockdown (EXT-2 / EXT-3)
- **EXT-2:** `REVOKE ALL … FROM anon, authenticated` on `loan_tasks`, `loan_events`,
  `loan_task_history`, `organizations`. Borrower reads go through the authenticated gateway only.
  `organization_members` keeps SELECT (RLS: own rows) for org resolution. RLS stays enabled as
  defense-in-depth.
- **EXT-3:** every RPC is `SECURITY DEFINER` with a pinned `search_path=public`; `REVOKE ALL` from
  `public`/`anon`/`authenticated` and `GRANT EXECUTE` to `service_role` only. The RPCs never trust a
  browser-supplied status/event/org/actor — the gateway sets the actor from the JWT and the DB derives
  the to-status and event type itself.

## Server-authoritative state machine + concurrency (EXT-4)
`ourmtg_task_transition` takes an **action** and an **expected revision** (not a status). It locks the
row `FOR UPDATE`, rejects a `revision` mismatch with `stale_task` (optimistic concurrency), re-validates
the graph via `ourmtg_task_next_status`, derives the event via `ourmtg_task_event_type`, and bumps
`revision`. A stale writer performs **zero** writes.

## Atomic document finalize + submit (EXT-5)
`ourmtg_document_finalize_submit` is one transaction: validate document/task/loan/org + borrower
participant + expected revision, mark the document `uploaded`, link it, transition to `submitted`, and
append history + event. Any failure rolls back everything. Storage existence is verified fail-closed by
the gateway **before** the RPC is called.

## Borrower-visible reason, participant targeting (EXT-6 / EXT-7)
`loan_tasks.borrower_visible_status_reason` holds the safe, borrower-facing reason set on
reject/more-info and cleared on resubmit/accept (internal `reason` is separate). `responsible_user_id`
(specific participant) + `shared_with_borrowers` (shared audience) drive participant targeting; a task
targeted to one borrower is not visible to another.

## Append-only protection & idempotency (EXT-8 / EXT-9 / EXT-12)
`loan_events` and `loan_task_history` have `BEFORE UPDATE OR DELETE` triggers
(`ourmtg_raise_immutable`) that RAISE — inserts only. Idempotency: `unique(organization_id,
idempotency_key)` on `loan_events` where the key is present, plus a `request_hash` column so the same
key + different payload raises `idempotency_conflict` (EXT-8). Notification **intents** are written in
the same transaction as the task change, deterministically keyed `intent:<idempotency_key>` (EXT-9 — no
send). **EXT-12:** `loan_events`/`loan_tasks` reference org and file with `ON DELETE RESTRICT` (no
cascade erasure of audit), `loan_task_history.task_id` is `ON DELETE RESTRICT` (a task cannot be hard
-deleted out from under its history), and `loan_tasks.archived_at` supports controlled soft archival.

## Deterministic organization backfill (EXT-13; deliberate, on a branch; NOT auto-run)
`organizations.slug` is `NOT NULL UNIQUE` — the stable conflict key. The commented backfill block runs
in order:
1. **Preflight** — RAISE if a `display_name = 'West Coast Capital Mortgage'` exists under a different
   slug (stop clearly; never pick arbitrarily by display name).
2. **Upsert** on `conflict (slug)` for `west-coast-capital-mortgage` (deterministic; never
   `ON CONFLICT DO NOTHING` on a non-stable key).
3. **Membership** backfill (existing loan-file owners → `loan_officer`).
4. **`loan_files.organization_id`** backfill for the single pilot org.
5. **Null/mismatch report** — `files_without_org` and `owners_without_membership` must both be `0`
   before any flag is enabled.

## Rollback & validation
The migration ships commented `-- ROLLBACK` (drop in reverse dependency order, incl. the three RPCs,
helper fns, the `loan_files.organization_id` column, and the guard fn) and `-- VALIDATION QUERIES`
(expect 5 tables, 3 RPCs; `has_table_privilege('authenticated', …loan_tasks…,'SELECT')` = false;
`has_function_privilege('authenticated', …transition…,'EXECUTE')` = false; immutability raises).

## Not applied
No migration has been run against any database. `git status` shows no schema execution. The only way to
exercise it is the branch acceptance script. Fake-adapter tests (`npm test`) prove adapter behavior and
are **not** a live-database test.
