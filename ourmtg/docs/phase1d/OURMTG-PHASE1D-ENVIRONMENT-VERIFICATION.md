# OURMTG — Phase 1D Environment Verification

**Verdict: C — PHASE 1D BLOCKED — ISOLATED DATABASE NOT PROVIDED.**

Phase 1D (isolated Supabase branch + preview acceptance) requires an explicitly confirmed isolated,
non-production Supabase branch and its credentials. The non-negotiable constraints forbid connecting to
or modifying production, any shared database, or any environment not explicitly approved as an isolated
disposable Supabase branch, and forbid using production provider credentials.

## §1 Code / PR baseline (safe; no database) — PASS

| Check | Result |
|---|---|
| Repository | `westccmortgage/Ourmtg` |
| Branch | `claude/ourmtg-phase1c-operational-pilot` |
| HEAD | `5e6df94ce67e28fefd73bc104f3aaf9a6699e0f0` |
| Contains required commit `5e6df94` | YES |
| Working tree | clean |
| Migration 043 location | `docs/phase1c/migration/043_ourmtg_operational_pilot.sql` only — **outside** `supabase/migrations/` (no such directory exists) |
| `npm ci` | PASS |
| `npm run check` | ok |
| `npm test` | **205 passed / 0 failed / 0 skipped** |
| `npm run build` | PASS |
| `npm audit` | 3 pre-existing advisories (1 moderate, 2 high); unchanged |

## §0 / §2 Environment isolation — BLOCKING

A redacted presence check (variable **names** only; no values printed) found **no** database or provider
credentials in this execution environment:

- No `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` / `SUPABASE_ANON_KEY`.
- No Postgres/`DATABASE_URL`/`PG*` connection variables.
- No `RESEND` / `TWILIO` / webhook / provider credentials.
- No `.supabase` directory, no branch marker, no pre-existing `docs/phase1d/` acceptance evidence.

Consequently:

- **Isolated acceptance branch (`ourmtg-phase1d-acceptance`): NOT PROVIDED.**
- **Isolated rollback-rehearsal branch (`ourmtg-phase1d-rollback-rehearsal`): NOT PROVIDED.**
- No production project reference is present either — there is nothing to compare, and there is no
  database this session could connect to.

Because there is no isolated, non-production Supabase branch (and no credentials), the hard-stop
condition in §0 is met. Connecting to any database would violate the constraints, and fabricating
database/live/preview/rollback results is prohibited. The phase stops here.

## Owner-approved decision (recorded, not yet validatable)

The owner confirmed that all pilot `loan_files` belong exclusively to West Coast Capital Mortgage Inc.,
and permits the single-organization WCC backfill **only after** migration 043's fail-closed read-only
inventory confirms the actual isolated-branch data is consistent with that decision. That validation
(§3 read-only preflight) **cannot be performed** without the isolated branch, so the decision remains
unverified against real data. If, once a branch is provided, the data contradicts the decision, the
migration's own preflight (`backfill_refused`) and this plan both require an immediate stop.

## Not performed (no isolated database available)

§3 read-only preflight · §4 pre-apply snapshot · §5 migration apply · §6 schema/privilege acceptance ·
§7 synthetic data · §8 live lifecycle · §9 authorization/RLS · §10 real idempotency/concurrency ·
§11 live atomic-failure proof · §12 notification-intent-only live proof · §13 preview environment ·
§14 mobile acceptance · §15 rollback rehearsal. **None run; no results fabricated.**

## Required §19 confirmations

- Code branch: `claude/ourmtg-phase1c-operational-pilot`
- Starting commit: `5e6df94`
- PR #1: OPEN / UNMERGED
- Production database modified: NO
- Production deployed: NO
- Production flags enabled: NO
- Migration 043 applied to production: NO
- Migration 043 applied to isolated acceptance branch: NO (no branch provided)
- Rollback executed on isolated rollback branch: NO (no branch provided)
- External notifications sent: NO
- Phase 1E started: NO

## Resume attempt after provisioning claim — credentials NOT present in this environment

A resume was requested stating branch-specific credentials had been injected securely. On re-check, the
credentials are **not reachable in this Claude Code session**:

- Unset: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE(_KEY)`, `SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`,
  `DATABASE_URL`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `PGHOST`/`PGURL`/`POSTGRES_URL`,
  `VITE_SUPABASE_URL`.
- No `.env*`, secret mount (`/run/secrets`, `/var/run/secrets`, `/etc/secrets`), `~/.supabase`,
  `.pgpass`, or branch-credential file exists.
- Only unrelated infra tokens are present (Anthropic / AWS / Google Cloud SDK / GitHub) — none is a
  Supabase branch credential, and none may be used to reach a database.
- Tooling: `psql` 16 **is** available, `@supabase/supabase-js` present; `supabase` CLI and the `pg`
  node module are **not** installed. No Supabase MCP tool is connected.

Because there is no reachable Supabase branch, §2 isolation cannot be confirmed and the phase remains
**BLOCKED**. No database was contacted and no results were fabricated. The likely cause is that the
secrets were injected into a different target (e.g., a Netlify preview/runner) rather than this session's
environment.

### Exactly what this session needs (injected as environment variables of THIS session)

- `SUPABASE_URL` — the isolated `ourmtg-phase1d-acceptance` branch API URL (not production).
- **`SUPABASE_DB_URL` (or `DATABASE_URL`) — a direct Postgres connection string for the branch.** This
  is required to APPLY migration 043 (DDL: `CREATE TABLE/FUNCTION`, `GRANT`, `ALTER`) and to run the
  privilege/RLS SQL checks; a service-role key over PostgREST alone **cannot** execute DDL. `psql` is
  already present to consume it.
- `SUPABASE_SERVICE_ROLE` — the branch service-role key (for RPC/table acceptance via `supabase-js`).
- The same set for `ourmtg-phase1d-rollback-rehearsal` (§15), and a non-production preview pointed only
  at the acceptance branch with pilot flags on and no production provider credentials (§13).

Once these are present in this session, re-run the resume and I will proceed at §2 → §3 (read-only
preflight, validating the owner's all-WCC decision against real data) → §5 apply, etc.

## To unblock

Provide an explicitly approved, isolated, **disposable** Supabase branch (non-production), created for
this acceptance, with its service-role credentials supplied through a secure channel — plus a
non-production preview environment pointed only at that branch and with no production provider
credentials. On receipt, this plan resumes at §2 (isolation re-confirmation) → §3 (read-only preflight)
before any migration apply.
