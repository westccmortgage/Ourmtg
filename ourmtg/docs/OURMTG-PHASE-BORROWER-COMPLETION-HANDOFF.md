# Phase handoff — borrower AI completion

**Branch:** `claude/ourmtg-borrower-ai-completion` (pushed; not merged)
**Base:** current `main` HEAD at start of phase — `f2cf9b6` "Fix company and broker licensing disclosure in OurMTG footer"
**Commits:** 4
**Diff:** 36 files, +4,571 / −191

Nothing was merged to `main`. No production migration was applied. No production deployment was
performed.

---

## 1. What this phase was for

OurMTG is not replacing ARIVE, and this phase added no ARIVE integration. The one job: take an
active WCCM borrower from an incomplete file to a clean, substantially complete borrower package
that staff can enter into ARIVE by hand.

The expensive part of that job was the iteration, not the typing:

```
borrower uploads → a loan officer eventually looks → the officer discovers page 6 is missing
  → the officer calls → the borrower uploads page 6 → the officer looks again
```

Every arrow but the first and the last cost a person an afternoon.

That loop now runs with nobody in it. The design rules that govern it are in
`docs/OURMTG-BORROWER-COMPLETION-LOOP.md`; this document is what changed and what was verified.

---

## 2. Baseline recorded before any change

Measured on a clean checkout of `main` in this container:

| check | result |
|---|---|
| `npm test` | 612 pass / 0 fail |
| `npm run check` | ok |
| `npm run build` | ok |
| migration rehearsal | 47 pass / 0 fail |
| UI harness | 9 screens, 0 real page errors |

One false alarm worth recording: the first `npm test` reported 72 failures. That was `node_modules`
being absent in a fresh container, not a code defect. `npm install` then produced 612/612. Nothing
was concluded about the code until that was established.

---

## 3. What was built

### The follow-up loop (the core of this phase)

- **`supabase/delta/009_document_read_queue.sql`** — `document_read_jobs`. Server-only, RLS on,
  all `anon`/`authenticated` grants revoked. One live job per document via a partial unique
  index, so a double tap cannot read (and bill for) the same PDF twice.
- **`netlify/functions/_lib/documentRead.mjs`** — the read-and-reanalyse core, lifted out of
  `pre-underwriting-intake.mjs`. There is now one definition of "read this document"; the
  internal endpoint is one of its two callers.
- **`netlify/functions/_lib/readQueue.mjs`** — enqueue, claim (compare-and-swap, not a lock),
  finish, reclaim abandoned claims. Three attempts, then `failed` with a code a person can see.
- **`netlify/functions/pre-underwriting-read-worker.mjs`** — scheduled every minute; drains up to
  3 jobs, reads each, re-analyses the whole file, and posts at most one borrower message.
- **`netlify/functions/portal-doc-complete.mjs`** — enqueues the read on upload, fail-soft.
- **`src/features/pre-underwriting/followUp.js`** — composes the message. Deterministic, never
  generated; every sentence is a count or is carried verbatim from `completeness.js`.

### One unified task state

- **`src/features/pre-underwriting/fileTasks.js`** — the canonical list. Borrower and team views
  are projections of one array.
- **`netlify/functions/_lib/fileState.mjs`** — loads a file once and hands it to that function.
- **`netlify/functions/portal-file-state.mjs`** — one endpoint, both audiences.
- The pre-underwriting panel's headline number was **replaced** by this one, not supplemented.

### Screens

- **`src/pages/BorrowerWorkspace.jsx`** (`/portal/workspace/:loanFileId`) — one page: the number
  with its meaning, the single next action, everything outstanding, the sections, the messages.
- **`src/pages/AriveHandoff.jsx`** (`/portal/file/:loanFileId/handoff`) — print-friendly entry
  sheet, internal only.

### ARIVE manual handoff

- **`src/features/pre-underwriting/ariveEntrySheet.js`** + **`portal-arive-handoff.mjs`**.
- **`src/features/pre-underwriting/documentPackage.js`** — organized package, derived filed-as
  names, auditable mapping, originals untouched.

### Document AI sharpening

- `completeness.js` now names the exact missing pages and describes which document it means.
- `extractionContract.js` gained a `pagelist` coercion, so `"1-5, 7"` and `"1,2,3,4,5,7"` are read
  as the same fact, and `"pages one to five"` is rejected rather than guessed at.
- Three universal checks added: `illegible`, `duplicate` (informational), `ownership_unclear`
  (needs confirmation, deliberately hard to trigger).

### Fixtures

- **`src/features/pre-underwriting/fixtures/documentScenarios.js`** — 12 named scenarios, each
  run through the real contract and the real rules. All data invented; the suite asserts that no
  SSN, account-number, email or real-institution shape appears.

---

## 4. Verification

Everything below was run in this container, at the branch head.

| check | result | notes |
|---|---|---|
| `npm test` | **699 pass / 0 fail** | was 612 at baseline |
| `npm run check` | **ok** | every function parses |
| `npm run build` | **ok** | |
| migration rehearsal | **57 pass / 0 fail** | was 47; delta 008 was never rehearsed before and now is, plus delta 009 |
| UI harness | **11 screens, 0 page errors** | was 9 |
| secrets in `dist/` | **none** | no service-role, model key, worker key or field key |

New end-to-end coverage:

- `tests/borrowerFollowUpJourney.test.mjs` (8) — upload → automatic read → automatic re-check →
  an ask naming page 6 → borrower sends it → the loop closes. Plus: the worker never repeats
  itself, never leaks a finding, never asks a borrower for the credit report, is not a public
  endpoint, and fails a removed document instead of retrying it.
- `tests/fileStateAndHandoff.test.mjs` (8) — the two views cannot disagree; a realtor is
  excluded; the handoff never claims a transfer.
- `src/features/pre-underwriting/fixtures/documentScenarios.test.js` (20).
- `followUp.test.js` (10), `documentPackage.test.js` (9), `ariveEntrySheet.test.js` (11),
  `fileTasks.test.js` (16).

**No existing test was deleted or weakened.** Two assertions in `completeness.test.js` were
updated to the new, more specific wording (`pages 1–5 and 7` rather than a bare count) and are
strictly stronger than what they replaced.

---

## 5. Requires your approval

**`supabase/delta/009_document_read_queue.sql` has NOT been applied to the live project.** It is
written, idempotent, and rehearsed (8 assertions against a real Postgres, including the live-job
uniqueness, the closed status vocabulary, re-runnability, and that the browser has no grants).

Until it is applied, the enqueue in `portal-doc-complete` fails soft and logs — uploads keep
working exactly as they do today, and documents are read only when someone presses the button on
the panel, which is the current behavior. **The automatic follow-up loop does not run until the
delta is applied.**

The new environment variable `OURMTG_READ_WORKER_KEY` is optional. Netlify scheduled functions
have no public URL, so the schedule is the only way in on a deployed site; the key exists so a
local `netlify dev` or a future re-plumbing of that file cannot become an unauthenticated way to
spend model credits. With no key set, the non-scheduled path is closed.

---

## 6. What I could not verify

Stated plainly rather than papered over:

- **No live model call.** `ANTHROPIC_API_KEY` is not available in this container. Every read in
  every test goes through a stub that returns model-shaped output, routed by the document's own
  bytes. The contract, the coercions and the refusal paths are exercised; actual model behavior
  on a real scanned PDF is not.
- **No live database.** The rehearsal runs against a local Postgres with a Supabase shim. It
  proves the DDL, the constraints, the indexes and the rollback. It does **not** prove RLS under a
  real anon/authenticated JWT, GoTrue, or the Storage API.
- **`ourmtg.com` is unreachable from this sandbox.** The egress proxy returns 403 on CONNECT — a
  policy denial, confirmed with curl. The UI harness is the substitute: the real built bundle in
  bundled Chromium, against the real Netlify functions, against the fake database.
- **Google Fonts is blocked in this sandbox** (`ERR_CERT_AUTHORITY_INVALID`). The harness now
  separates that from real page errors — narrowly, by host and error code — and still records it
  in the report rather than hiding it. The site renders in system fonts here; nothing else differs.
- **The verbatim list of the 11 named fixture scenarios from the original brief was lost to a
  context compaction.** The set I built is derived from the document-AI behaviors the brief
  enumerates, and came to 12. The suite asserts behavior coverage rather than a count. **If any
  of your named scenarios is missing, tell me the names and I will add them.**

---

## 7. Deliberately not done

- **No ARIVE integration**, as instructed. The handoff endpoint returns `transfer.occurred: false`
  as data, and a test asserts no string in the response implies a transfer.
- **No approve / deny anywhere.** Still absent rather than disabled: no column, no action, no
  endpoint. The reviewer vocabulary remains confirm / correct / dismiss / reanalyse.
- **`portal-checklist` was left as it is.** It is the upload screen's data source and feeds the
  same `assessCompleteness`; the canonical "what is outstanding" answer is `fileTasks`, which is
  what the two new screens read. Folding the checklist into it would have changed a response
  shape the existing upload UI depends on, for no behavior gain this phase.
- **No rate limit on `portal-file-state` / `portal-arive-handoff`.** Both are authenticated
  read-only endpoints, consistent with `portal-checklist` and `portal-status`. The expensive
  path (`pre-underwriting-intake`) keeps its 20/min limiter, and the worker is bounded by its
  batch size.
- Carried forward from earlier phases and still open: two consent texts remain `reviewed: false`;
  NSF/transaction-level deposit analysis, reserves, occupancy cross-check and CLTV are not built;
  `docs/CONVERSATIONAL-1003-FIELD-COVERAGE.md` still lists unmapped fields.

---

## 8. Suggested next steps

1. Review the branch.
2. Apply delta 009 to the live project when you are ready — it is safe to run twice and touches
   no existing row.
3. Deploy a preview and confirm the scheduled function appears in Netlify's function list.
4. Set `PRE_UNDERWRITING_ENABLED=true` and, if you want them mounted, the `VITE_FF_*` flags.
5. Watch the first real follow-up on a live file before turning it on for everyone: the messages
   are deterministic, so what you see on one file is what every borrower gets.
