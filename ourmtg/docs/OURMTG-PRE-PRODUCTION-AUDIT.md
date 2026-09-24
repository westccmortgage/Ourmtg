# Pre-production audit — borrower AI completion

**Audited branch:** `claude/ourmtg-borrower-ai-completion`
**HEAD at audit start:** `d6778d17cc3bf5533f7e43e6cd90e412e6bdec2a`
**HEAD after audit fixes:** `72195f96a7ff682f3595c5e50a389c1f05e2b154`
**Merge base with `origin/main`:** `f2cf9b67883972d95f906743134de803d9b707d9`

Not merged. Not deployed. **Delta 009 remains unapplied.**

---

## 1. The commits

The five audited commits, oldest first:

| # | SHA | Subject |
|---|---|---|
| 1 | `0808dba` | Read a borrower's upload automatically and ask for exactly what is missing |
| 2 | `8e93ae7` | One unified file state, an organized document package, and an ARIVE entry sheet |
| 3 | `31d3529` | Two screens off one list, and a harness that builds what it tests |
| 4 | `24bab15` | Twelve named document scenarios, and the three checks they proved were missing |
| 5 | `d6778d1` | Audit the automatic reads, and write down the rules the loop runs on |

The audit added a sixth, `72195f9`, holding only the fixes below.

---

## 2. Findings

Three defects, all fixed and pinned by tests. Severity is about production consequence, not
about how hard they were to find.

### F3 — a shaky read became a confident demand · **HIGH** · fixed

**Reproduced, not inferred.** An extraction flagged `needsHumanReview: true`,
`reviewReasons: ["low_confidence_classification","illegible","low_confidence_fields"]`,
`minFieldConfidence: 0.19`, `legible: false` produced this automatic borrower message:

> We could not read your September Northharbor Savings Bank statement clearly enough. Please
> send a clearer photo or scan…
>
> We received pages 1–5 and 7 of your September Northharbor Savings Bank statement. **Page 6 is
> still missing** — please upload it.

The second claim rests entirely on values read from the document we had just told the borrower
we could not read. The page count behind it was read at 0.19 confidence. A borrower acting on it
hunts for a page that may not exist, and the message contradicts itself in the same breath.

`needsHumanReview` and `reviewReasons` were being computed and stored, and **nothing on the
borrower path consulted them**.

*Fix.* The reader's verdict now travels on the part (`extractionContract.toPart`) and
`fileTasks.js` consults it. Only requests whose truth does not depend on an extracted value
survive a shaky read — `illegible` (the reader's verdict on itself), `not_provided` and
`unknown_type` (computed from the absence of an upload). Everything else becomes a **blocking**
`human_review` task carrying the reader's own reasons. Nothing is dropped, the file cannot read
as complete, and a person gets the specific gap.

Also routed team-only: **`ownership_unclear`**, and anything carrying `needsConfirmation`. Its
message quotes the name read off the document, so a document filed onto the wrong loan — the
clerical slip that check exists to catch — would have disclosed a third party's name to whoever
holds this borrower's portal login.

### F1 — a stalled worker could overwrite the job taken from it · **MEDIUM** · fixed

Worker A claims a job and stalls past `CLAIM_TTL_MS`; `requeueStale` hands the job back; worker
B claims it and begins reading; A finally returns and writes `done` over B's `running`. The
document is read — and billed — twice, and the queue reports a completion that has not happened.

Guarding on `status = 'running'` does **not** fix this, and the reason is the interesting part:
when B owns the job the row *is* running, because B is running it. The two workers agree on the
status and disagree about who owns it.

*Fix.* `finish()` fences on `claimed_at`, which is set afresh on every claim, and returns
`lost: true`. The loser stays quiet instead of messaging the borrower about a run whose result
was discarded. A tie would need two claims of the same job in the same microsecond, which the
ten-minute reclaim TTL precludes.

A second, smaller issue in the same file: `readStateForFile` picked the newest job per document
by `created_at desc`, and several attempts can land in one clock tick. An arbitrary winner makes
a file that *is* being read report as failed, or the reverse. It now prefers any live job over
any terminal one, and only among terminal rows does recency decide.

### F2 — the worker did not account for itself · **MEDIUM** · fixed

Nobody watches this run, so the record it leaves is the only account of what it did. Before the
fix: a **suppressed** follow-up left no record at all, a sent one reached only stdout, and a read
that threw or found the document gone left nothing.

*Fix.* Every read outcome and every message decision writes a durable `portal_access_log` row.
Suppression reasons are recorded explicitly — a decision to stay silent is as much a decision as
a decision to write, and it is the half nobody can reconstruct afterwards.

---

## 3. Item-by-item verification

| # | Item | Verdict |
|---|---|---|
| 1 | Five commits + full diff reviewed | Done — 3 defects found, fixed, pinned |
| 2 | Delta 009 backward-compatible / idempotent / rollback | **PASS** — rollback was missing; written and rehearsed |
| 3 | Queue concurrency, retries, partial-unique, duplicate messages | **PASS after F1 fix** — 9 dedicated tests |
| 4 | Follow-up limited to high-confidence, non-decisioning requests | **PASS after F3 fix** — was failing |
| 5 | Complete audit record for reads and messages sent *or suppressed* | **PASS after F2 fix** — was failing |
| 6 | One canonical state; findings never leak to borrower | **PASS** |
| 7 | ARIVE remains a manual-entry aid | **PASS** |
| 8 | Full suites at HEAD | **PASS** |
| 9 | Local/staging Supabase migration + RLS/JWT | **PARTIAL** — see §7 |
| 10 | Report | This document |

### Item 2 — Delta 009

**Backward-compatible.** Additive only: one `create table if not exists`, three
`create index if not exists`, `enable row level security`, `revoke`. No column is added to an
existing table, no row is touched, no trigger or function is created or replaced. Code at `main`
never references `document_read_jobs`, so applying 009 to production while old code runs is a
no-op.

**Idempotent.** Every statement is `if not exists` or naturally repeatable. Rehearsed by
re-running the file and asserting the result is unchanged.

**Rollback.** `supabase/delta/009_document_read_queue_rollback.sql`. Safe because the dependency
direction is one-way: the table's two foreign keys point **out** (`loan_files`,
`loan_documents`) and nothing in the schema points back at it — verified, and the rollback itself
re-checks `pg_constraint` and refuses rather than orphaning if that ever changes. It holds no
conclusions: a row says a read is *owed*, never what it found. Dropping it loses only the
knowledge of which reads were pending; those documents remain on the file and the panel's manual
read recovers every one.

Rehearsed the way it would actually be used — against a queue with work in flight, run twice,
then rolled forward again.

### Item 3 — concurrency

`tests/readQueue.test.mjs`, nine properties:

- explicit `attempts: 0` / `max_attempts` on insert (not left to column defaults)
- the live-job partial unique index stops a double-tap being read twice; the second enqueue
  returns **success** with `deduped: true`, because a read *is* owed
- two workers racing one job: exactly one wins, and the loser burns no attempt
- **a stalled worker cannot overwrite the job taken from it** (F1)
- a failing job retires at `MAX_ATTEMPTS` with `attempts_exhausted` and leaves the queue
- `last_error` bounded to 500 chars
- a finished job frees the document to be re-read after a re-upload
- read state prefers a live job over a terminal one, tie-proof
- an unreachable database never fails the upload

**Duplicate borrower messages** are blocked at three levels: the live-job index (one read per
document), the F1 claim fence (a superseded run stays silent), and `composeFollowUp` comparing
against the last delivered message with whitespace normalised. Residual risk in §6.

### Item 4 — what may be sent automatically

Two explicit lists in `fileTasks.js`: `SAFE_WHEN_UNSURE` (survives a low-confidence read) and
`NEVER_AUTOMATIC` (`ownership_unclear`, plus anything `needsConfirmation`). Findings were already
structurally excluded — `human_review` is never borrower-owned and `borrowerView` selects on
ownership, so a finding is *absent from* the borrower payload rather than filtered out of it.

### Item 6 — one canonical state

One `loadFileState` → one `buildFileTasks` → two projections. `borrowerView` is the only
borrower projection in the codebase; both borrower-facing consumers (`portal-file-state`'s
borrower branch and the worker's follow-up) read it. Tests assert every borrower task is also a
team task, that the team sees strictly more, and that no finding text reaches the borrower.

### Item 7 — ARIVE

Verified against the **rendered page**, not just the payload. After removing the three explicit
negations from the text, no affirmative transfer claim survives (`submitted/transferred/synced/
exported/pushed/uploaded to ARIVE`, `ARIVE api`, `integration`, `sync`). `transfer.occurred` is
`false` and arrives from the server as data, so no component can omit the disclaimer. Blanks
render as `— blank —` and are shown by default; contradictions render under "Ask before
entering" and are never resolved; secure fields render `— collect in ARIVE —` with a note saying
where to get them, and no SSN-shaped string appears anywhere on the page.

---

## 4. Delta 009 — objects and rollback

**Table** `public.document_read_jobs`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `organization_id` | uuid | |
| `loan_file_id` | uuid not null | → `loan_files(id)` **on delete cascade** |
| `document_id` | uuid not null | → `loan_documents(id)` **on delete cascade** |
| `status` | text not null | default `queued`; check `queued\|running\|done\|failed` |
| `attempts` | int not null | default 0 |
| `max_attempts` | int not null | default 3 |
| `requested_by` | text not null | default `borrower_upload`; check `borrower_upload\|loan_team\|system` |
| `last_error` | text | bounded to 500 chars by the writer |
| `last_error_code` | text | |
| `correlation_id` | text | |
| `created_at` | timestamptz not null | `now()` |
| `claimed_at` | timestamptz | **the claim fencing token** |
| `finished_at` | timestamptz | |

**Indexes**

| name | definition |
|---|---|
| `document_read_jobs_pkey` | `(id)` |
| `document_read_jobs_live_doc_idx` | **unique** `(document_id) where status in ('queued','running')` |
| `document_read_jobs_queue_idx` | `(status, created_at) where status in ('queued','running')` |
| `document_read_jobs_file_idx` | `(loan_file_id, created_at desc)` |

**Policies:** none, deliberately. RLS is enabled with zero policies and all privileges revoked
from `anon` and `authenticated` — server-only, double-locked. The worker and the upload endpoint
reach it with the service role, which bypasses RLS.

**Triggers:** none. **Functions:** none. **Views:** none.

**Rollback:** `supabase/delta/009_document_read_queue_rollback.sql`.

> **Stop the worker first**, or it will error once a minute against a missing table.
> `PRE_UNDERWRITING_ENABLED=false` is the fastest lever (the worker 404s before any query);
> removing the scheduled function and redeploying also works.
>
> If you forget: nothing is corrupted. `enqueueRead` is fail-soft so uploads still succeed,
> `readStateForFile` returns empty on error so both screens keep rendering, and the worker's own
> try/catch turns the failure into a 500 nobody sees.

---

## 5. Worker, schedule, and environment

**Function:** `netlify/functions/pre-underwriting-read-worker.mjs`
**Schedule:** `export const config = { schedule: '* * * * *' }` — every minute, UTC.
**Batch:** 3 jobs per tick. **Claim TTL:** 10 minutes. **Attempts:** 3.

**Reachability.** Netlify scheduled functions have no public URL — *"You can't invoke scheduled
functions directly with a URL"* (docs.netlify.com/build/functions/scheduled-functions). The
schedule is the only way in on a deployed site. `OURMTG_READ_WORKER_KEY` guards the
non-scheduled path so a local `netlify dev`, or a future re-plumbing of this file as an ordinary
function, cannot become an unauthenticated way to spend model credits. It fails closed: with no
key set and no schedule marker, the worker 404s.

**Deployment requirement:** the function must appear in Netlify's scheduled-function list after
deploy. Confirm this before enabling the flag — a scheduled function that silently failed to
register leaves uploads queued and never read, and the only symptom is a borrower who is never
answered.

### Environment variables

| variable | required | effect |
|---|---|---|
| `PRE_UNDERWRITING_ENABLED` | **yes** | Gates the worker and all pre-underwriting endpoints. `false` disables the loop entirely — the incident lever. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` | **yes** | Already set; the worker uses the service role. |
| `ANTHROPIC_API_KEY` | **yes** | The read. Absent ⇒ `provider_not_configured`, jobs retry and retire. |
| `OURMTG_DOCUMENT_SCAN_PROVIDER` + `OURMTG_DOCUMENT_SCAN_URL` + `OURMTG_DOCUMENT_SCAN_TOKEN` | **yes** | Malware scan before bytes cross the provider boundary. Fail-closed. |
| `CONVERSATIONAL_1003_ENABLED` | yes for the 1003 half | |
| `OURMTG_READ_WORKER_KEY` | optional | Non-scheduled invocation. Omit in production. |
| `VITE_FF_PRE_UNDERWRITING`, `VITE_FF_CONVERSATIONAL_1003` | build-time | **Presentation only** — they mount routes and authorize nothing. Must be set at build time or the new screens 404. |

---

## 6. Remaining production risks

Ordered by what I would watch first.

1. **No live model call has ever been made by this code.** `ANTHROPIC_API_KEY` is absent here.
   Every read in every test goes through a stub returning model-shaped output. The contract, the
   coercions, the refusal paths and the confidence gate are exercised; real model behaviour on a
   real scanned PDF is not. **This is the largest residual risk and the reason for a one-file
   pilot.**
2. **Overlapping ticks can produce two messages on one file.** A tick that runs past 60s can
   overlap the next. Two workers reading two *different* documents on the *same* file both
   compute state, both read the same "last message", and can both write — a few seconds apart,
   both correct, merely noisy. F1 covers the same-document case; this is the cross-document one.
   Mitigations if it proves real: a per-file advisory lock, or a short quiet period.
3. **A wrong `pagesTotal` read at high confidence still produces a wrong ask.** The confidence
   gate stops low-confidence claims, not confidently-wrong ones. Only real traffic shows this
   rate.
4. **Cost is unbounded per file.** Every upload enqueues a read; a borrower who re-uploads ten
   times pays for ten reads. The live-job index stops simultaneous duplicates, not sequential
   ones. No per-file or per-day read budget exists.
5. **`create table if not exists` would silently accept a pre-existing table of a different
   shape.** Not a live concern for a new table; worth knowing if 009 is ever partially applied.
6. **Follow-ups are portal-only.** They land in `loan_messages`; nothing emails or texts. A
   borrower who does not open the portal is not reached, and the loop stalls silently.
7. **No alerting on a stuck queue.** A job in `failed` with `attempts_exhausted` is visible on
   the panel but nothing pages anyone.
8. **Two consent texts remain `reviewed: false`** (carried from earlier phases), and
   `regulatoryReadiness` still reports `blocked`.

---

## 7. What could not be verified, and exactly what is missing

Stated precisely rather than papered over. **No secrets were requested and none should be sent
in chat** — the items below are environment access, to be arranged out of band.

### Verified locally, in full
- Migration chain + delta 009 + rollback against **real PostgreSQL 16** — 75 assertions.
- **Role-level access control**, genuinely: the rehearsal shim now reproduces Supabase's default
  `anon`/`authenticated` grants, so RLS is actually consulted rather than everything failing at
  the privilege layer. A control assertion proves the harness works (a signed-in borrower *can*
  read their own timeline via `auth.uid()`), and then `anon` and `authenticated` are denied
  select/insert/update/delete on `document_read_jobs` while `service_role` succeeds.

  **This is what changed the item-9 verdict from "not possible" to "partial".** Before this pass
  the shim granted nothing, every role-level query failed for the wrong reason, and
  `revoke all from anon, authenticated` had never been tested at all.

### Not verified — and what each needs

| Not verified | What is missing |
|---|---|
| Real GoTrue JWT issuance and PostgREST role switching | A Supabase project (staging preferred). The shim emulates `auth.uid()` from a session setting, not a signed JWT. |
| Supabase Storage behaviour under RLS | Same. Document download in tests uses the fake's storage. |
| Real model behaviour on real scanned PDFs | `ANTHROPIC_API_KEY` in an environment authorised to spend on it. |
| Real malware-scanner behaviour | `OURMTG_DOCUMENT_SCAN_URL` + token for the live scanner. |
| Netlify scheduled-function registration and actual cadence | A deploy preview. Cannot be observed from here. |
| End-to-end delivery to a real borrower inbox/portal session | Staging with a seeded test borrower. |

**Environment blockers in this container:** Supabase CLI not installed; Docker installed but not
running, so `supabase start` is unavailable; `ourmtg.com` unreachable (the egress proxy denies
CONNECT with 403 — a policy denial, confirmed with curl). Google Fonts is blocked
(`ERR_CERT_AUTHORITY_INVALID`); the UI harness separates that from real page errors by host and
error code and still records it.

---

## 8. Verification at HEAD `72195f9`

| check | result | at audit start |
|---|---|---|
| `npm test` | **716 pass / 0 fail** | 699 |
| `npm run check` | **ok** | ok |
| `npm run build` | **ok** | ok |
| migration rehearsal (real Postgres 16) | **75 pass / 0 fail** | 57 |
| UI harness | **11 screens / 0 page errors** | 11 |
| secrets in `dist/` | **none** | none |
| secrets in tracked source | **none** | — |
| working tree | **clean**, local == remote | — |

No existing test was deleted or weakened. One assertion in the fixture suite was **replaced with
a stronger pair**: "every incomplete scenario produces a borrower ask" was the pre-audit
assumption that F3 disproved, and it is now "an incomplete document always becomes somebody's
job" plus "a borrower is asked only where the ask is safe, and never otherwise".

---

## 9. Controlled production rollout

Each step has a stated check and a stated rollback. Do not proceed past a failed check.

**Step 0 — merge.** Merge the branch to `main`. No runtime behaviour changes: every new path is
behind `PRE_UNDERWRITING_ENABLED`, which is off.
*Check:* CI green. *Rollback:* revert the merge.

**Step 1 — deploy preview, feature off.** Deploy with `PRE_UNDERWRITING_ENABLED` unset.
*Check:* `pre-underwriting-read-worker` appears in Netlify's scheduled-function list; the site
renders; uploads still work.
*Rollback:* delete the preview.

**Step 2 — apply Delta 009.** Run `supabase/delta/009_document_read_queue.sql` against
production. Additive, idempotent, touches no existing row.
*Check:* the file's own verification query prints
`PASS - read queue exists, RLS on, one live job per document, no client access`.
*Rollback:* `009_document_read_queue_rollback.sql` (worker is not running yet, so no ordering
concern).

**Step 3 — confirm the browser cannot reach the queue.** From the browser console as a signed-in
borrower, select from `document_read_jobs`.
*Check:* permission denied or zero rows. **This is the one check the local rehearsal cannot
fully stand in for** (§7) — do it against the real project.
*Rollback:* Step 2's.

**Step 4 — enable for ONE pilot file.** Set `PRE_UNDERWRITING_ENABLED=true` and the build-time
`VITE_FF_*` flags. Choose a live file with a cooperative borrower and tell them a test is
running.
*Check, on that file:* upload a document with a genuinely missing page →
- the job appears `queued` then `done` within ~2 minutes;
- `portal_access_log` shows `pre_underwriting_intake_auto` and exactly one
  `borrower_followup_sent`;
- the borrower's message names the right page;
- the borrower's screen and the internal panel show the **same** percentage.

Then upload something deliberately blurry. *Check:* the borrower is asked for a clearer copy and
**is not** given a page-level claim; the panel shows a `human_review` task with the reader's
reasons. **This is the F3 regression check and the most important observation of the pilot.**
*Rollback:* `PRE_UNDERWRITING_ENABLED=false` — instant, no migration change.

**Step 5 — watch one full loop.** Have the borrower send the missing page.
*Check:* one follow-up confirming completion, no repeats; a `borrower_followup_suppressed` row
with reason `unchanged` on any tick that had nothing new to say.

**Step 6 — widen to ~5 files, one week.**
*Watch:* model spend per file against risk 4; duplicate messages against risk 2; `failed` jobs
and their `last_error_code`; any borrower reply saying an ask made no sense.
*Rollback:* the flag.

**Step 7 — general availability.** Only after a week with no un-actionable ask, no duplicate
message, and spend per file inside expectations.

**Standing incident lever, at every step from 4 on:** `PRE_UNDERWRITING_ENABLED=false`. It stops
the worker before any query and leaves the data untouched. Reach for the rollback migration only
if the table itself is implicated.
