# Phase 1B draft migrations — DO NOT APPLY

`OURMTG-1B-operational-schema.DRAFT.sql` defines the first production-ready operational schema
(10 entities) as a **guarded, non-runnable** planning artifact:

- Begins with a `RAISE EXCEPTION` guard — pasting it into the SQL editor aborts immediately.
- Lives **outside** `ourmtg/supabase/migrations/` and carries **no runnable sequence number**.
- Introduces the mandated explicit **`organization_id`** tenancy boundary on every table.
- `loan_events` and `loan_task_history` are **append-only** (SELECT-only RLS + immutability trigger).
- Idempotency on `loan_events (organization_id, idempotency_key)`; FKs to existing `loan_files`,
  `loan_conditions`, `loan_documents`, `auth.users`; RLS + rollback included.

Entities: `organizations`, `organization_members`, `loan_events`, `loan_tasks`,
`loan_task_history`, `loan_milestones`, `cash_to_close_items`, `cash_to_close_snapshots`,
`disclosure_packages`, `third_party_items`.

**Nothing is applied in Phase 1B.** When these become real migrations (future phase, owner
approval): backfill a default organization mapping `owner_user_id → organizations`, review FKs
against the live 036–039 schema, then apply in `supabase/migrations/` with the standard runbook.
This supersedes the Phase 0 drafts `040`/`041` (which used `owner_user_id`-only tenancy).
