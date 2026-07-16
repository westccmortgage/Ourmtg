# OURMTG — Phase 1C Data Migration

**File:** `docs/phase1c/migration/043_ourmtg_operational_pilot.sql` — production-shaped, **NOT
APPLIED**, and intentionally OUTSIDE `supabase/migrations/` so it is never auto-run. Apply to a
**Supabase branch** only, after owner approval (see `OURMTG-TASK-PILOT-ACCEPTANCE.md`).

## Promoted entities (minimum for the pilot)
`organizations`, `organization_members`, `loan_events`, `loan_tasks`, `loan_task_history` — plus two
atomic RPCs (`ourmtg_task_create`, `ourmtg_task_transition`). Cash-to-close, disclosures, milestones,
notifications, and third-party tables are **not** promoted this phase.

## Reconciliation with 036–039 (does NOT alter existing objects)
- FKs reference existing `loan_files(id)`, `loan_conditions(id)`, `loan_documents(id)`, `auth.users(id)`.
- Reuses the 036 `set_updated_at()` trigger fn for `updated_at`.
- Existing `portal_users`, `portal_access`, `portal_invites`, `loan_documents`, `loan_conditions`,
  `portal_consent`, `portal_access_log`, `loan_strategy`, `app_state`, and storage policies are **untouched**.
- The Phase 0 drafts `040`/`041` (owner_user_id-only tenancy) are superseded — this pilot uses `organization_id`.

## Organization boundary
Every pilot task/event carries `organization_id`. Membership is `organization_members` (explicit,
never email-domain inferred). RLS: members read their own org/membership; borrowers read only their
own borrower-facing tasks via a `portal_access` grant; `loan_events`/`loan_task_history` have no
borrower SELECT (internal-only, default-deny). Writes go through the service-role gateway + RPCs.

## Append-only protection
`loan_events` and `loan_task_history` have `BEFORE UPDATE OR DELETE` triggers
(`ourmtg_raise_immutable`) that RAISE — inserts only. Idempotency: `unique(organization_id,
idempotency_key)` on `loan_events` where the key is present.

## Backfill (deliberate, on a branch; NOT auto-run)
1. Insert the WCC organization.
2. Map `distinct owner_user_id` from `loan_files` → `organization_members(role='loan_officer')`
   (explicit, `on conflict do nothing`). **Not** from email domain.
3. (Optional, future) add `loan_files.organization_id` — deferred to avoid altering the existing
   table in the pilot; the gateway resolves a file's org via membership under the single-org assumption.
Existing borrower/document/consent rows are not modified.

## Rollback & validation
The migration ships commented `-- ROLLBACK` (drop in reverse dependency order, incl. RPCs + guard fn)
and `-- VALIDATION QUERIES` (expect 5 tables, 2 functions; immutability raises on update/delete).

## Not applied
No migration has been run against any database. `git status` shows no schema execution. The only
way to exercise it is the branch acceptance script.
