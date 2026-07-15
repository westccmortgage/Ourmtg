# Draft migrations — DO NOT APPLY

These `.DRAFT.sql` files are **Phase 0 planning artifacts**. They are:

- **Non-runnable.** Each begins with a `RAISE EXCEPTION` guard so pasting one into the Supabase
  SQL editor aborts immediately. They are also **outside** `ourmtg/supabase/migrations/`, so the
  manual migration process (which runs files from that folder in order) never picks them up.
- **Separate from the migration sequence.** The last real migration is `039_site_settings.sql`.
  Real Phase 1+ migrations will be authored later, in `supabase/migrations/`, starting at `040`.
- **Reconciled, not copied.** Every object here maps to the existing 036–039 schema documented
  in `docs/OURMTG-TARGET-DATA-MODEL.md` (Part B). None re-declares an existing table or enum.

To turn a draft into a real migration (Phase 2+, NOT now): copy the body (without the guard) into
`supabase/migrations/040_*.sql`, review FKs/RLS/indexes against the live schema, and follow the
deploy runbook. Do **not** simply uncomment/rename these files.

| Draft | Objects | Target-model ref | Phase |
|---|---|---|---|
| `040_loan_events_and_deliveries.DRAFT.sql` | `loan_events`, `notification_deliveries` | B1, B3 | 2 |
| `041_tasks_vendor_ctc.DRAFT.sql` | `loan_tasks`, `loan_vendor_orders`, `loan_cash_to_close` | B2, B4, B5 | 3 (owner-gated) |
| `042_cron_heartbeat.DRAFT.sql` | `cron_heartbeat` (operational infra) | Part C | Apply only if verified missing (Phase 1A #6) |

> **Future tenancy directive (owner, Phase 1A):** `owner_user_id`-only tenancy is NOT the
> final model. The FIRST real operational migrations (Phase 2+) must introduce an explicit
> `organization_id` boundary. When these drafts become real migrations, add `organization_id`
> (FK to an organizations table) alongside `owner_user_id`, index it, and scope RLS by it.
> See `docs/OURMTG-TARGET-DATA-MODEL.md` Part E.
