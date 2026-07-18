# OurMtg production read-only inventory — 2026-07-18

Target Supabase project: `diqukqhbmqcheffhensp`.

No database write, migration, storage operation, authentication event, deployment, or
secret retrieval was performed during this inventory.

## Executive result

The existing production project already exposes every table and every expected column
needed by the first team-to-borrower browser workflow. The clean baseline must therefore
not be applied wholesale to this project.

The safe next database step is a privileged read-only inspection of policies, constraints,
indexes, triggers, storage buckets, and actual row counts. Only a minimal reviewed delta may
be prepared after that inspection.

## Connection evidence

- The deployed `https://ourmtg.com` bundle points to
  `https://diqukqhbmqcheffhensp.supabase.co`.
- The bundle contains a Supabase publishable key, as expected for a browser application.
  Its value was used in memory for read-only requests and was never printed or written.
- The deployed `portal-status` Netlify Function returns `401 Unauthorized`, rather than the
  function's `503 Service not configured` response. This confirms that the server runtime
  has its Supabase configuration without exposing the server key.
- Supabase's anonymous OpenAPI schema endpoint requires a secret key and correctly returned
  `401`. No attempt was made to obtain or expose that key.

## Core table and column comparison

The check used `GET ...?select=<expected-column>&limit=0` with the public key. Response
bodies containing rows were not retained. A successful response proves that the named table
and column are present in the PostgREST schema cache; it does not prove policy, constraint,
index, trigger, or actual-row-count parity.

| Table | Expected columns | Result |
|---|---:|---|
| `loan_files` | 15 | all present |
| `portal_users` | 6 | all present |
| `portal_access` | 5 | all present |
| `portal_team` | 5 | all present |
| `portal_invites` | 13 | all present |
| `loan_documents` | 12 | all present |
| `loan_conditions` | 8 | all present |
| `loan_messages` | 8 | all present |
| `portal_consent` | 9 | all present |
| `portal_access_log` | 7 | all present |
| `loan_strategy` | 10 | all present |
| `site_settings` | 3 | all present |

Result: **12 of 12 core tables and 101 of 101 expected core columns are present.**

`site_settings` exposes one public row, which is expected for the public site configuration.
The remaining core tables returned an anonymous count of zero. Because RLS may hide rows,
that is not evidence that their actual database row counts are zero.

## Objects deliberately absent

The following known experimental or later-phase tables returned PostgREST `PGRST205`
(`table not found`):

- `organizations`
- `organization_members`
- `loan_tasks`
- `loan_task_history`
- `loan_events`
- `cash_to_close_items`
- `cash_to_close_snapshots`
- `loan_cash_to_close`
- `loan_milestones`
- `loan_vendor_orders`
- `notification_deliveries`
- `disclosure_packages`
- `third_party_items`

This confirms that the experimental migration 043 task/organization layer is not active in
the production PostgREST schema and is not required for the first workflow.

## Optional and unresolved objects

- `cron_heartbeat` is absent. It is used only as a fail-soft operational signal by the
  optional GRCRM projector and is not required for the first borrower/team workflow.
- A public Storage metadata request reported `Bucket not found` for `ourmtg-docs`. Supabase
  may conceal a private bucket from a public key, so this result is **inconclusive**. Verify
  the bucket with a privileged read-only query before creating anything.
- Public inspection cannot prove the exact RLS policies, constraints, indexes, triggers,
  table privileges, storage policies, or actual protected row counts.
- Public inspection cannot prove that `OURMTG_ADMIN_EMAILS` is configured in Netlify.

## Required privileged read-only checks

Before any database write, use a securely injected database URL or Supabase service/admin
connection to verify:

1. Actual row counts for the 12 core tables, without selecting borrower data.
2. RLS enabled state and every policy definition on the core tables.
3. Expected primary keys, foreign keys, unique/check constraints, indexes, and update
   triggers.
4. `ourmtg-docs` bucket existence, `public = false`, and absence of public object-read
   policies.
5. Function/table grants available to `anon`, `authenticated`, and `service_role`.
6. Netlify's `OURMTG_ADMIN_EMAILS` allowlist is configured before manual file creation is
   deployed.

Do not paste the database password or service-role key into chat, source control, build
output, or a browser-visible environment variable.

## Decision boundary

- Apply consolidated baseline to the existing project: **NO**.
- Apply migration 043: **NO**.
- Create `cron_heartbeat` now: **NO; not required for the first workflow**.
- Create or modify the Storage bucket now: **NO; privileged verification first**.
- Prepare a minimal SQL delta after privileged inventory: **YES**.

