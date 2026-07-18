# OurMtg clean foundation

Primary Supabase project: `diqukqhbmqcheffhensp`.

## First usable version

The first release uses the product that already exists instead of introducing another
workflow layer:

1. An approved loan-team user signs in and creates a loan file.
2. The team adds the primary borrower and optional co-borrower through identity-bound invites.
3. The team creates an exact `loan_documents` request.
4. The borrower signs in, sees the request, and uploads to the private `ourmtg-docs` bucket.
5. The team views the upload and accepts, rejects, or requests another copy.
6. Both sides see the document status and borrower-safe portal history.

`loan_documents` is the version-one document task. A second task table and a 13-state
lifecycle do not improve this first workflow enough to justify the additional database,
feature-flag, RPC, backfill, and rollback machinery.

## Keep

- Vite, React Router, Netlify Functions, and the current `ourmtg/` directory layout.
- Supabase magic-link authentication.
- Loan-team, borrower, co-borrower, Realtor, escrow, and title views.
- Identity-bound, expiring invitations.
- Existing loan-file, document, condition, message, and review screens.
- Server-authorized signed uploads and downloads in private Storage.
- GRCRM/Arive integration boundaries; neither is the version-one database prerequisite.

## Simplify

- Use `supabase/baseline/001_ourmtg_core.sql` as the clean core schema source.
- Keep one core document lifecycle: `requested -> uploaded -> accepted/rejected`.
- Use `loan_messages` plus `portal_access_log` for version-one history.
- Treat `OURMTG_ADMIN_EMAILS` as the fail-closed platform-admin allowlist.

## Reconnect

- Point browser and Netlify server variables at `diqukqhbmqcheffhensp`.
- Treat the clean baseline as the fresh-install reference, not as a migration to run
  wholesale over the existing project.
- Run a privileged read-only inventory, compare the existing objects with the baseline,
  and prepare only the exact reviewed delta that is still needed.
- Configure Supabase Auth Site URL and redirect URLs for the OurMtg preview.
- Create one approved loan-team Auth user, one borrower Auth user, and one test loan.
- Run the complete workflow in separate team and borrower browser sessions.

## Do not activate for the first release

- Migration 043 or its rollback companion.
- `organizations`, `organization_members`, `loan_tasks`, or `loan_task_history`.
- Phase 1D acceptance and rollback rehearsals.
- Task-pilot feature flags and task RPCs.
- Email/SMS delivery, AI Supervisor, disclosures/e-sign, or Arive synchronization.

These files may remain as historical reference until the core browser workflow passes.
They are not part of the clean baseline and must not be applied to the primary project.

## Safety boundary

The baseline is prepared but not automatically applied. Before any database change:

1. Confirm the connected project ref is exactly `diqukqhbmqcheffhensp`.
2. Run a privileged read-only inventory of tables, columns, policies, triggers, indexes,
   buckets, and actual row counts.
3. Stop if any table contains operating borrower or document data.
4. Do not apply the consolidated baseline to the existing project. Prepare and review a
   minimal delta only for confirmed missing objects or protections; never apply 043.
5. Never expose the service-role key or database password to the browser bundle.
