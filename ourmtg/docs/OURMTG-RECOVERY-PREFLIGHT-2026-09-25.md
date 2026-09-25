# Migration recovery — preflight · **HALTED AT GATE 4**

## Recommendation

# NOT READY

**Four of five preflight gates pass.** Gate 4 (backup/PITR from authoritative evidence) cannot be
satisfied from this environment, and your instruction was explicit: *"Do not apply SQL until every
preflight gate passes"* and *"If the backup dashboard is inaccessible, stop and tell me exactly
what screen I must verify."*

**No SQL was applied. No deployment was made.** Every statement issued against any Supabase
project this session was a `SELECT`.

What you need to check is in §4 — it is two screens and about ninety seconds.

---

## 1. Gate 1 — the live site targets `diqukqhbmqcheffhensp` ✅ **PASS**

Verified from the **live production bundle**, not from config I could have been mistaken about.

| Evidence | Result |
|---|---|
| `https://ourmtg.com/` | HTTP 200, `index.html` 1,119 bytes |
| Live JS bundle | `/assets/index-B2o0pllF.js` (663,346 bytes) |
| Supabase hosts referenced in that bundle | **`https://diqukqhbmqcheffhensp.supabase.co` — exactly one** |
| Any other Supabase host | none |
| Key material present | 2 × `sb_publishable_…` (real, not placeholder) |
| `PLACEHOLDER` strings | 0 |
| **`service_role` in the client bundle** | **0** ✅ |

Confirmed ref: **`diqukqhbmqcheffhensp`** — *Our Mortgage Database*, us-west-1, PostgreSQL 17.6,
`ACTIVE_HEALTHY`.

**Smoke-test baseline — what is live right now.** None of this branch's surfaces are deployed:

| String in live bundle | Count |
|---|---|
| `application/assistant` | 2 (1003 is live) |
| `pre-underwriting` | 1 |
| `portal/workspace` | **0** |
| `handoff` / `portal-arive-handoff` / `portal-file-state` | **0** |
| `Operationally complete` / `ARIVE entry sheet` | **0** |

---

## 2. Gate 2 — the migration ledger ✅ **PASS (answered)**

**There is no project migration ledger. At all.**

| Object | State |
|---|---|
| `supabase_migrations` schema | **ABSENT** |
| `supabase_migrations.schema_migrations` | **ABSENT** |
| Ledger-shaped tables anywhere | only Supabase's own internals: `auth.schema_migrations`, `storage.migrations`, `realtime.schema_migrations` |
| Non-system schemas | `auth, extensions, graphql, graphql_public, public, realtime, storage, vault` |

### Your three categories, answered

| Category | Verdict |
|---|---|
| **Absent from both ledger and schema** | **YES — this is the case for 007 and 008.** And the ledger is absent for *every* delta, including 001–006. |
| Marked applied but structurally missing | **NO** — nothing is marked, because nothing records marks. |
| Partially applied | **NO** — see the structural audit below. 001–006 are complete; 007/008 are wholly absent, not half-done. |

### Structural audit of 001–006 (necessary, since no ledger can be trusted)

| Delta | Marker | State |
|---|---|---|
| 001 | `loan_strategy` policy dropped | no policies ✅ *(correct — 001 drops with no replacement)* |
| 001 | `loan_strategy` revoked from anon/authenticated | 0 grants ✅ |
| 001 | `loan_files_amount_check` / preapproval check | both present ✅ |
| 001 | `ourmtg-docs` bucket private | private ✅ |
| 002 | statement income tables | 2 of 2 ✅ |
| 003 | conversational 1003 tables | 6 of 6 ✅ |
| 004 | `loan_files.owner_user_id` FK delete rule | **RESTRICT** ✅ *(the ownership protection)* |
| 005 | `application_turns.taken_by` / `taken_via` | 2 of 2 ✅ |
| 005 | `application_turns_taken_via_check` | 1 ✅ |
| 006 | pre-underwriting tables | 3 of 3 ✅, RLS on all three ✅ |
| **007** | `dedupe_key` column | **ABSENT** ❌ |
| **007** | `pre_underwriting_findings_live_rule_idx` (the pre-007 index 007 drops) | **STILL PRESENT** ❌ |
| **008** | its four tables | **0 of 4** ❌ |
| 009 | `document_read_jobs` | absent (correct — not yet applied) |

---

## 3. Gate 3 — why the audit said 001–008 were applied ✅ **PASS (answered)**

The claim was **wrong**, and the repository already contained the evidence contradicting it.

### The decisive line

`docs/OURMTG-SECURITY-COMPLIANCE-READINESS.md:5`:

> **Delta 008:** review source only; **not applied to any database.**

That document has been in the tree since delta 008 was written. The "001–008 applied" statement
contradicted it.

### Why no ledger exists

`docs/OURMTG_DEPLOY.md:16`:

> Open the **SQL editor** for the shared project and run, in order:

Deltas are applied by **hand-pasting into the Supabase SQL Editor**. That mechanism writes nothing
to `supabase_migrations.schema_migrations` — which is precisely why the ledger has never existed
for any of 001–006 either. The absence of a ledger is not evidence of a failed migration; it is
the expected consequence of the documented process.

### Your four options, checked

| Option | Verdict |
|---|---|
| **Another Supabase project** | **NO.** I checked all six projects in the organisation. `WCCI CRM`, `Pegasus Lenders Group`, `Private Note Capital`, `MeasuredDecisionAi`, `EMIADA` — **none has `public.loan_files` at all**, let alone the deltas. `diqukqhbmqcheffhensp` is the only OurMTG database in existence. |
| **A local database** | **YES — the most likely source.** `supabase/rehearsal/run-rehearsal.sh` applies 001→009 to a throwaway local Postgres and reports "75 passed". Summarised carelessly across a context compaction, "the chain applies cleanly" becomes "the chain is applied". |
| **Migration files only** | **YES, contributing.** Files `001`–`009` all exist in `supabase/delta/`. Their presence says nothing about any database. |
| **Incorrect migration history** | **NO.** There is no history object; it never existed, so it cannot be wrong. |

### Why nobody noticed

Delta 007 was written 2026-08-06 to fix a bug found by a regression test — a file with two
undisclosed creditors 500s on the second insert. In production that bug **has never had the chance
to fire**: `document_extractions` and `pre_underwriting_findings` are both **0 rows**. The
pre-underwriting feature has never run against live data, so the missing delta produced no symptom.

---

## 4. Gate 4 — backup / PITR ❌ **CANNOT VERIFY — THIS IS THE STOP**

### What I established authoritatively

| Fact | Value | Source |
|---|---|---|
| Organisation | *Pegasus Lenders Group LLC* | Supabase API |
| **Plan** | **`pro` / `tier_pro`** | Supabase API |
| Project status | `ACTIVE_HEALTHY` | Supabase API |

On the **Pro** plan, daily backups are **included by plan**. That is authoritative about
*entitlement*.

### What I cannot establish, and why it matters

Entitlement is not a restorable backup. None of these are exposed by any tool available here:

- whether a backup actually **exists** right now,
- its **timestamp** (is the most recent one 6 hours old or 6 days?),
- whether the last scheduled run **succeeded**,
- whether **PITR** is enabled — on Pro it is a **paid add-on, off by default**.

You were explicit that `archive_mode` and `wal_level` are insufficient. I agree, and I am not
offering them as a substitute. The Supabase MCP surface has **no backup tool**; the only
restore-adjacent tool is `restore_project`, which un-pauses a paused project and is unrelated
(I did not call it).

### The exact screens you must verify

**Screen 1 — Scheduled backups**

```
https://supabase.com/dashboard/project/diqukqhbmqcheffhensp/database/backups/scheduled
```

Navigate: **Project “Our Mortgage Database” → Database (left sidebar) → Backups → “Scheduled
backups” tab.**

Confirm, and tell me: **at least one backup is listed, and the timestamp of the most recent one.**
If the list is empty on a Pro project, that is itself a finding worth pausing on.

**Screen 2 — Point in Time**

```
https://supabase.com/dashboard/project/diqukqhbmqcheffhensp/database/backups/pitr
```

Navigate: same place → **“Point in Time” tab.**

Confirm, and tell me: **enabled or not.** If enabled, the start of the recovery window. If it shows
an upgrade prompt, PITR is off — which is fine, and worth knowing rather than assuming.

### A faster route, if you prefer

This database is **13 MB — 24 tables, ~266 live rows, 3 loan files**. A manual logical backup takes
seconds and satisfies this gate independently of plan features:

**Dashboard → Database → Backups → “Download backup”**, or `pg_dump` against the project's
connection string from your own machine. If you take one, tell me it exists and when — that is
sufficient for me to proceed, and it is strictly better evidence than a scheduled backup you have
not looked at.

---

## 5. Gate 5 — the deployment commit ✅ **PASS**

### Diff `ac84181..524b34e`

```
 ourmtg/docs/OURMTG-ROLLOUT-ATTEMPT-2026-09-25.md      | 238 +++++++++
 ourmtg/supabase/rehearsal/run-remediation-rehearsal.sh | 177 +++++++
 2 files changed, 415 insertions(+)
```

Files under `netlify/` or `src/` (excluding tests) changed: **NONE.** One report, one rehearsal
shell script. **No unaudited runtime behaviour.**

### Verified at `524b34ecd50ea9298f248e04b494382673bb69c2`

| Check | Result |
|---|---|
| Working tree | clean |
| `npm test` | **716 pass / 0 fail** |
| `npm run check` | **ok** |
| `npm run build` | **ok** |

---

## 6. Two decisions I need before applying anything

Neither is something I should settle alone.

### 6a. The ledger will be created partial — is that what you want?

`apply_migration` **creates** `supabase_migrations.schema_migrations` and records what it applies.
If I use it for 007 → 008 → 009, the resulting ledger will contain **only those three**, implying
to any future operator that the chain began at 007 and that 001–006 were never applied. That is a
new, misleading artifact where previously there was an honest absence.

| Option | Consequence |
|---|---|
| **(a)** `apply_migration` for 007/008/009, accept a partial ledger, document it | You get a real ledger going forward; the gap is recorded in docs, not in the database |
| **(b)** Also backfill 001–006 as ledger rows | Cleanest ledger — but it is **additional SQL you have not approved**, and it asserts application dates I cannot evidence |
| **(c)** `execute_sql`, matching how 001–006 were applied | Consistent with history; leaves no ledger at all, so the next operator faces the same puzzle |

**My recommendation: (a).** It starts a truthful ledger from today without my inventing history.
But you asked me to read back the ledger after each migration, so you may have intended (b) —
tell me which.

### 6b. Delta 008 scope

008 has **no code dependency** — nothing in the tree references its four tables (verified by
search). It is not required for this release. You authorised 007 → 008 → 009, so I will apply it
as instructed; I am flagging only that 008 is optional for *function*, and that applying it keeps
the chain contiguous. Say so if you would rather defer it.

---

## 7. Security baseline, taken before any change

`get_advisors(security)` at `2026-09-25T16:08:53Z`:

- **`rls_enabled_no_policy` — INFO, 14 tables.** **Expected and correct.** These are the
  server-only tables: RLS on, zero policies, all client grants revoked, reachable only by the
  service role. Delta 009's `document_read_jobs` will make it **15** — that increase is the design
  working, not a regression.
- `function_search_path_mutable` — WARN, `public.set_updated_at`. Pre-existing, unrelated.
- `auth_leaked_password_protection` — WARN, disabled. Pre-existing, unrelated.

I will re-run this after the migrations so the before/after is on the record.

---

## 8. Deployment path — resolved in advance, so you needn't come back twice

**Browser OAuth is possible.** Netlify's CLI uses a **ticket flow**, not a localhost callback:

```
Logging into your Netlify account...
Opening https://app.netlify.com/authorize?response_type=ticket&ticket=<id>…
◈ Waiting for authorization...
```

It prints a URL, **you** open it in your own browser and authorise, and the CLI here receives the
token into this machine's config. **No token is ever printed or pasted into this conversation.**

When we reach deployment I will run `netlify login`, hand you the fresh URL, and wait. (The ticket
from this probe is dead — abandoned deliberately.)

Recorded for that step: `npx netlify status` → *"Not logged in"*; no `NETLIFY_AUTH_TOKEN` in this
container; `api.netlify.com` reachable (HTTP 401, i.e. reachable and unauthenticated).

Publish directory, from the committed root `netlify.toml` — the single source of truth, and not to
be overridden in the Netlify UI:

| Setting | Value |
|---|---|
| base | `ourmtg` |
| command | `npm run build` |
| publish | `dist` → **`ourmtg/dist`** |
| functions | **`ourmtg/netlify/functions`** (41 functions) |

---

## 9. What happens when you come back

Give me the two backup facts from §4 and your answer to §6a, and I will:

1. Re-verify the schema immediately before each migration.
2. Apply **007**, read back, verify — column, backfill, index swap, row counts, grants, RLS, ledger.
3. Apply **008**, read back, verify — **including RLS on every one of its four tables**, as you
   required, even though no runtime code touches them.
4. Apply **009**, read back, verify — the full step-4 list from the original approval.
5. Stop immediately on any mismatch, with `PRE_UNDERWRITING_ENABLED` still false throughout.

Rehearsal evidence for exactly this transition already exists:
`supabase/rehearsal/run-remediation-rehearsal.sh` — delta-006 replica **with data in it** → 007 →
008 → 009, **20 assertions, all passing**, including reproducing the pre-007 two-creditor failure
first so the fix is demonstrated rather than assumed.

---

## 10. Final report fields

| Field | Value |
|---|---|
| Confirmed production Supabase project ref | **`diqukqhbmqcheffhensp`** (verified from the live bundle) |
| Migration-ledger state **before** | **No ledger exists.** `supabase_migrations` schema absent. 001–006 structurally complete; 007, 008 absent; 009 absent |
| Migration-ledger state **after** | **Unchanged — no migration applied** |
| Backup/PITR evidence | Org plan **`pro`** (daily backups included by entitlement). **Existence, recency and PITR status NOT verified** — dashboard inaccessible from here; see §4 |
| Delta 007 result | **NOT APPLIED — halted at preflight** |
| Delta 008 result | **NOT APPLIED — halted at preflight** |
| Delta 009 result | **NOT APPLIED — halted at preflight** |
| Exact deployed commit | **None deployed.** Live site still serves `index-B2o0pllF.js`, which predates this branch |
| Netlify deployment ID | **None** |
| Synthetic-pilot result | **Not run** — requires deployment, which requires the migrations |
| **Recommendation** | **NOT READY** |
