# Controlled rollout — attempt 2026-09-25 · **HALTED AT STEP 3**

## Recommendation

# NOT READY

Not because of a defect in the audited release. Because **the production database is not in the
state the rollout was approved against**, and because the deployment and pilot steps cannot be
executed from this environment at all.

**No production SQL was applied. No deployment was made. Production is exactly as it was found**
— read-back evidence in §6.

---

## 1. The stop condition

Step 1 asked me to confirm the production position before touching anything. Doing so surfaced
this:

| Delta | Expected (per the approved audit) | **Actually in production** |
|---|---|---|
| 001–006 | applied | **applied** ✅ |
| **007** — finding identity | applied | **NOT APPLIED** ❌ |
| **008** — security/compliance readiness | applied | **NOT APPLIED** ❌ |
| 009 — read queue | to be applied now | absent (correct) |

Evidence, from the live database (project `diquk…`, *Our Mortgage Database*):

- `pre_underwriting_findings` columns: `id, organization_id, loan_file_id, rule, category,
  severity, explanation, evidence, source_documents, min_confidence, needs_human_review, status,
  resolved_by, resolved_at, resolution_note, corrected_fields, rules_version, catalog_version,
  run_id, superseded_by, created_at` — **no `dedupe_key`**.
- Its indexes include **`pre_underwriting_findings_live_rule_idx`** — the *pre-007* index, the
  one delta 007 exists to drop.
- Delta 008's four tables: **0 of 4** present.

### Why this stops the rollout rather than merely delaying it

The audited code depends on delta 007 on **every document read**:

- `netlify/functions/_lib/preUnderwritingRepo.mjs:200` — writes `dedupe_key` on every findings
  insert.
- `:157` — selects `dedupe_key` on every findings read.

Against the live schema both fail. The consequence is not subtle: every automatic read would
complete its extraction, then throw on the findings write, and the job would retry three times
and land in `failed`. **The borrower would be asked for nothing and the loop would appear simply
dead.** Step 8's checks (with the feature off) would all pass, and the failure would only appear
in step 10 — after a production migration and a production deploy had already been spent.

Worse, the still-live `pre_underwriting_findings_live_rule_idx` is the exact defect delta 007
was written to fix: a file with two undisclosed creditors 500s on the second insert.

**Delta 008 is a different matter.** Nothing in the tree references its four tables — verified
by search. It is a schema gap, not a runtime one, and it does not block the release.

Applying Delta 009 alone would have *succeeded* — its guard only checks for `loan_documents` and
`document_extractions`, both present — and produced a 006+009 schema that has never been
rehearsed, while leaving the release non-functional. Per instruction 5 I stopped rather than
improvising the additional SQL, which is instruction 5's other half.

---

## 2. Step-by-step outcome

| Step | Required | Outcome |
|---|---|---|
| 1 | Confirm backup/recovery position | **Done, partial** — see §3 |
| 2 | Keep `PRE_UNDERWRITING_ENABLED=false` | **Honoured** — never set |
| 3 | Apply Delta 009 only | **NOT DONE — halted.** Prerequisite 007 missing |
| 4 | Read back and verify | Not reached |
| 5 | Stop on failure, don't improvise SQL | **Honoured** — this document is the stop |
| 6 | Build audited HEAD `ac84181` | **Done** — §4 |
| 7 | Deploy via Netlify ZIP/manual | **BLOCKED** — no credentials in this container |
| 8–12 | Post-deploy checks, synthetic pilot | Not reachable without step 7 |
| 13 | No real borrower, no merge to main | **Honoured** |
| 14 | Report | This document |

---

## 3. Step 1 — backup and recovery position

**What I could establish** (from inside the database):

| Fact | Value |
|---|---|
| Engine | PostgreSQL 17.6, `ACTIVE_HEALTHY`, region us-west-1 |
| `wal_level` | `logical` |
| `archive_mode` | `on` — WAL archiving is running, which is what Supabase's backups and PITR are built on |
| Database size | **13 MB** |
| Public base tables | 24 |
| Total live rows, all public tables | **~266** |
| Largest table | `portal_access_log`, 153 rows |
| `loan_files` | **3 rows** |
| `pre_underwriting_findings` | **0 rows** |
| `document_extractions` | **0 rows** |

**What I could NOT establish:** whether daily backups or point-in-time recovery are *retained
and restorable* for this project. That is a plan/dashboard fact and the Supabase MCP surface
exposes no backup tool. **Confirm it in the dashboard before step 3 is retried.**

**Materiality.** Lower than it would normally be, and worth saying why rather than leaving it as
a checkbox: this is effectively a pre-launch database. 13 MB, 3 loan files, and the
pre-underwriting feature has never run — both of its tables are empty. Deltas 007/008/009 are
additive (007 adds a column, backfills it, and swaps an index; 008 and 009 create tables), and
each has a rehearsed rollback or is a single `DROP TABLE`. The realistic worst case is a failed
migration on a 13 MB database with 266 rows.

---

## 4. Step 6 — the build

Built from a **clean detached checkout of the audited commit**, not from my working tree.

| | |
|---|---|
| Commit | `ac84181d9899beb3339454f940922d75dfbc9231` |
| Working tree at that commit | clean |
| `npm run check` | **ok** |
| `npm test` | **716 pass / 0 fail** |
| `npm run build` | **ok** — `dist/index.html`, `dist/assets/index-*.js`, `dist/assets/index-*.css`, `icon.svg`, `manifest.webmanifest` |
| Functions to ship | 41, including `pre-underwriting-read-worker.mjs` carrying `export const config = { schedule: '* * * * *' }` |

**The artifact I produced has been deleted, deliberately.** I had to supply build-time
`VITE_SUPABASE_*` values and used an obvious placeholder, so the bundle would not have worked
against the real project. Handing over a production-looking ZIP that silently cannot authenticate
is worse than handing over none. **Build it through your existing Netlify path, where the real
build-time variables are already configured.** What step 6 establishes is that the audited commit
is clean, green and buildable — that is confirmed.

---

## 5. Step 7 — why deployment is blocked

| Check | Result |
|---|---|
| `netlify` CLI | not installed |
| `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` / `NETLIFY_TOKEN` | absent |
| `api.netlify.com` reachable | yes — **HTTP 401** (reachable, unauthenticated) |
| `ourmtg.com` reachable | yes — HTTP 200 |

The API is reachable and I have no credentials for it. **I am not asking for any**, and none
should be pasted into this conversation. Steps 8–12 all require a deployed production site, so
they are unreachable as a consequence, not independently.

---

## 6. Read-back: production is unchanged

Run after all investigation, as proof this session wrote nothing:

| Object | State |
|---|---|
| `document_read_jobs` (delta 009) | **ABSENT — not created** |
| `dedupe_key` on findings (delta 007) | **ABSENT — unchanged** |
| `pre_underwriting_findings_live_rule_idx` | **PRESENT — unchanged** |
| Delta 008 tables | **0 of 4** |
| Public base tables | 24 |
| `loan_files` / findings / extractions rows | 3 / 0 / 0 |

Every statement I ran against production was `SELECT`. The only projects touched were reads
against `diquk…`; the other five projects in the organisation were not queried.

---

## 7. What I did instead: rehearsing the migration production would actually make

`supabase/rehearsal/run-rehearsal.sh` proves the chain 001→009 applied in order from nothing.
That is *not* the transition production would make. So I built
**`supabase/rehearsal/run-remediation-rehearsal.sh`**, which proves the real one:

> a database at **delta 006, with data in it** → 007 → 008 → 009

**20 assertions, all passing.** The design points worth knowing:

- It **refuses to continue** unless the staged replica matches production's actual shape
  (006 present, no `dedupe_key`, pre-007 index live, no 008 tables). A rehearsal against the
  wrong starting state proves nothing.
- It **reproduces the pre-007 defect on the replica first** — two undisclosed creditors, second
  insert refused — so the fix afterwards is demonstrated rather than assumed.
- After migrating: the pre-existing finding survives; `dedupe_key` is backfilled from the rule
  name; the old index is gone; the same two-creditor insert now succeeds; and **a findings write
  in the exact shape the audited code emits goes through**.
- All three deltas are then re-run, confirming a half-finished production run can simply be
  retried.

This is evidence for your decision, produced entirely locally. It is not a substitute for the
production run.

---

## 8. What is needed to resume

Nothing here requires a secret in chat.

1. **Decide on deltas 007 and 008.** 007 is mandatory — the release cannot function without it.
   008 has no code dependency and could be deferred, though applying it keeps the chain
   contiguous and it is rehearsed either way. This is **outside the scope you approved**, which
   was "Apply Delta 009 only", so it needs your explicit word.
2. **Confirm the backup/PITR position** in the Supabase dashboard (§3).
3. **Establish how I should deploy, or deploy it yourself.** Either grant this environment
   Netlify credentials through the environment's secret store — *not* through chat — or run
   step 7 on your side and tell me the deployment ID, and I can resume from step 8.
4. **Explain the drift.** The audit recorded 001–008 as applied to this project. They are not.
   Either they were applied to a different project, or rolled back, or never ran. Worth knowing
   which before applying anything, because it says whether the live schema can be trusted to be
   what the chain would have produced.

### Suggested revised sequence, for your approval

Unchanged from the audited plan except where the drift forces it:

1. Confirm backups/PITR in the dashboard.
2. Apply **007**, then **008**, then **009** — in that order, one at a time, reading back after
   each. (Rehearsed together: `run-remediation-rehearsal.sh`, 20/20.)
3. Verify: 007's own `PASS` line, `dedupe_key` not-null on every row, the pre-007 index gone,
   008's four tables, then the full delta-009 read-back from the original step 4.
4. Resume the approved sequence at step 6.

The original step-4 verification list and the step-9→12 synthetic pilot stand as written. So does
the standing incident lever: **`PRE_UNDERWRITING_ENABLED=false`**, which stops the worker before
it issues any query.

---

## 9. Verification at `9593b3b`

| Check | Result |
|---|---|
| `npm test` | 716 pass / 0 fail |
| `npm run check` | ok |
| `npm run build` | ok |
| Migration rehearsal (001→009, real Postgres 16) | 75 pass / 0 fail |
| **Remediation rehearsal (006 + data → 007 → 008 → 009)** | **20 pass / 0 fail** |
| UI harness | 11 screens / 0 page errors |
| Secrets in `dist/` or tracked source | none |
| Production writes this session | **zero** |
