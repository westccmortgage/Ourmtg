# OurMtg production read-only inventory — 2026-07-18

Target Supabase project: `diqukqhbmqcheffhensp`.

No database write, migration, storage operation, authentication event, deployment, or
secret retrieval was performed during this inventory.

## Executive result

The existing production project already contains every table and every expected column
needed by the first team-to-borrower browser workflow. A privileged read-only inventory was
completed successfully in an explicit read-only transaction. The clean baseline must not be
applied wholesale to this project.

The core is structurally usable and RLS is enabled everywhere. Three narrow hardening gaps
were confirmed: raw `loan_strategy.payload` can be selected through an old approved-strategy
policy, the two non-negative amount checks are missing from `loan_files`, and the private
document bucket has no database-enforced file-size or MIME allowlist. The guarded delta is
`supabase/delta/001_live_core_hardening.sql`; it was subsequently approved, applied, and
verified on 2026-07-18.

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

## Privileged row counts

The privileged inventory selected aggregate counts only, never borrower/document contents.

| Object | Rows |
|---|---:|
| `auth.users` | 3 |
| `loan_files` | 2 |
| `loan_documents` | 1 |
| `loan_messages` | 2 |
| `portal_access_log` | 14 |
| `portal_consent` | 4 |
| `portal_team` | 1 |
| `site_settings` | 1 |
| `loan_conditions` | 0 |
| `loan_strategy` | 0 |
| `portal_access` | 0 |
| `portal_invites` | 0 |
| `portal_users` | 0 |

Production is therefore **not empty**. No baseline, reset, backfill, or destructive cleanup
may be run against it.

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

## Privileged security findings

- `cron_heartbeat` is absent. It is used only as a fail-soft operational signal by the
  optional GRCRM projector and is not required for the first borrower/team workflow.
- RLS is enabled on all 12 existing core tables.
- The expected identity-bound SELECT policies exist for portal access, conditions,
  documents, messages, consent, access history, invites, team membership, portal identity,
  and public site settings.
- `loan_files` has no browser policy and is server-only, as intended.
- `loan_strategy` has the old `portal read approved strategy` SELECT policy. Because RLS
  cannot hide only the raw `payload` column, this policy must be dropped and browser table
  privileges revoked. The table currently contains zero rows.
- No browser write policies exist on the core tables. Supabase's broad default table grants
  are therefore constrained by RLS; service-role Netlify Functions remain the write path.
- All expected primary keys, foreign keys, role/status checks, unique constraints, indexes,
  and three `set_updated_at()` triggers are present. The two baseline non-negative amount
  checks are missing and are included in the guarded delta.
- `borrower_name` is nullable in production. This is retained intentionally because the
  existing GRCRM projector permits a contact identified by email or phone before a name is
  known; manual loan-file creation still requires a name in the server handler.
- The `ourmtg-docs` bucket exists and is private. There are no public `storage.objects`
  policies. Its `file_size_limit` and `allowed_mime_types` are unset, so the delta enforces
  the existing client cap of 25 MB plus PDF/JPEG/PNG/HEIC/HEIF at Storage level.
- Netlify's `OURMTG_ADMIN_EMAILS` value remains outside database visibility and must be
  confirmed before the hardened creation handler is deployed.

`supabase/inventory/001_privileged_read_only.sql` returns these sections inside one JSON
value and one result row so Supabase SQL Editor can export the complete inventory instead
of exporting only the final section.

Do not paste the database password or service-role key into chat, source control, build
output, or a browser-visible environment variable.

## Decision boundary

- Apply consolidated baseline to the existing project: **NO**.
- Apply migration 043: **NO**.
- Create `cron_heartbeat` now: **NO; not required for the first workflow**.
- Create or replace workflow tables: **NO; production data exists**.
- Minimal hardening delta prepared: **YES**.
- Minimal delta contents: **drop/revoke raw strategy browser access; add two guarded amount
  checks; enforce private Storage + 25 MB/MIME limits**.
- Apply the minimal delta: **COMPLETED 2026-07-18 after separate approval**.

## Post-inventory hardening verification

The SQL Editor verification row confirmed all intended results after delta 001:

- `strategy_browser_policy_present`: `false`
- `strategy_browser_privileges`: `[]`
- both `loan_files` amount checks present
- `ourmtg-docs.public`: `false`
- `ourmtg-docs.file_size_limit`: `26214400`
- MIME allowlist: PDF, JPEG, PNG, HEIC, HEIF

No baseline, migration 043, borrower-row rewrite, or production deployment was performed.
