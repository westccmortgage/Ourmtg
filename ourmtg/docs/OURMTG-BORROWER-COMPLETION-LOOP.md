# The borrower completion loop

**What this document is for.** It describes the one behavior this phase added and the rules that
govern it, so that a change to any piece of it is made deliberately. If you are about to touch
`followUp.js`, `fileTasks.js`, `readQueue.mjs`, or the read worker, read this first.

---

## 1. The problem

OurMTG is not replacing ARIVE. ARIVE is and remains West Coast Capital Mortgage's system of
record, and nothing in this product submits anything to it. OurMTG has one job: take an active
WCCM borrower from an incomplete file to a clean, substantially complete borrower package that
staff can enter into ARIVE by hand.

The expensive part of that job was never the typing. It was the iteration:

```
borrower uploads
  → a loan officer eventually looks
  → the officer discovers page 6 is missing
  → the officer calls or texts
  → the borrower uploads page 6
  → the officer looks again
```

Every arrow but the first and the last costs a person an afternoon, and the borrower spends the
gaps between them not knowing whether they are finished. A file typically goes round that loop
three or four times before anyone can start keying it.

## 2. The loop, now

```
borrower uploads
  → portal-doc-complete enqueues a read          (document_read_jobs, delta 009)
  → pre-underwriting-read-worker drains the queue on a schedule
      → _lib/documentRead.mjs reads the document and re-analyses the WHOLE file
  → _lib/fileState.mjs recomputes what the file still needs
  → followUp.js composes at most ONE message naming exactly what is missing
  → the borrower fixes it, and the loop closes itself
```

No WCCM employee initiates any of it.

### Why a queue and not a promise

A read is a model call against a whole PDF and takes tens of seconds. The upload function is
frozen the instant it responds, so work started there and not awaited is killed mid-flight —
silently, on exactly the uploads that matter. A durable row survives that. The enqueue is also
fail-soft: a document we already have must never be reported as failed because a queue insert
was, so a dropped enqueue costs a delayed read, which the panel's manual read button and the
next upload both recover from.

### Why the message is deterministic and not generated

A model writing free text to a borrower can, on a bad day, reassure them, quote a number, guess
at a missing month, or characterize their file. None of those are recoverable once sent. Every
sentence `followUp.js` produces is either composed from a count or carried **verbatim** from
`completeness.js`, which is a pure function over what was actually received. The worst this
module can do is be unhelpful.

### Why it stays quiet

Silence is the default. Nothing is sent unless the outstanding set actually changed since the
last thing we said — a borrower who gets a message every time a background job runs stops
reading them, and the one that mattered is the one they skipped.

### Why it only speaks when it is sure

A request is sent automatically only when it does not rest on a value the reader was unsure of.
`validateExtractionResponse` already decides whether a read `needsHumanReview` — low-confidence
classification, low-confidence fields, an illegible page — and that verdict now travels on the
part and is consulted before anything reaches a borrower.

The failure this prevents, found during the pre-production audit and now pinned by a test: an
extraction with `minFieldConfidence: 0.19` on a document the reader itself called illegible
produced the message *"We could not read your September statement clearly enough"* immediately
followed by *"We received pages 1–5 and 7. Page 6 is still missing."* The second sentence is a
confident claim built entirely on values from the document we had just said we could not read,
and it sends someone hunting for a page that may not exist.

Two rules, in `fileTasks.js`:

- **`SAFE_WHEN_UNSURE`** — `illegible`, `not_provided`, `unknown_type`. These survive a shaky
  read because their truth does not depend on any extracted value: the first is the reader's
  verdict on itself, the others are computed from the absence of an upload.
- **`NEVER_AUTOMATIC`** — `ownership_unclear`, and anything carrying `needsConfirmation`. The
  ownership message quotes the name read off the document; if a document was ever filed onto the
  wrong loan — the ordinary clerical slip that check exists to catch — sending it automatically
  would disclose a third party's name to whoever holds this borrower's portal login.

Everything else, when the read is shaky, becomes a blocking `human_review` task carrying the
reader's own reasons. Nothing is dropped: the file still cannot read as complete, and a person
is given the specific gap.

---

## 3. The audience rule

This is the line the whole feature is built around, and it is enforced structurally rather than
by care.

A **finding** — "Discover shows a payment of $340 not on the application" — characterizes the
applicant. It is internal by definition (`docs/OURMTG-PRE-UNDERWRITING-BOUNDARY.md`).

A **request** — "Page 6 of your July statement is still missing" — asks for a document. It says
nothing about the person and is safe to send.

In `fileTasks.js`, a finding is a task of kind `human_review` and is **never** borrower-owned.
`borrowerView()` selects on ownership. A finding is therefore *absent from the borrower's
payload*, not filtered out of it: there is no field it could be rendered from, and no bug in a
component can surface one. `followUp.js` reads `borrowerView(tasks)` and nothing else, so it
inherits the same guarantee rather than re-implementing it.

---

## 4. One unified task state

`src/features/pre-underwriting/fileTasks.js` is the single canonical answer to "what does this
file still need". The borrower's screen and the loan team's panel are two **projections** of one
array, never two computations.

The bug this prevents: a borrower told "all in — nice work!" while the panel shows two
outstanding items. That is not fixable by being careful on two screens. It is fixed by the two
screens rendering the same list, which is what `_lib/fileState.mjs` loads and
`portal-file-state` serves to both audiences.

Five kinds of task:

| kind | owner | in the borrower's view |
|---|---|---|
| `application_answer` | borrower | yes |
| `application_conflict` | borrower | yes |
| `document` | borrower or loan team | only when theirs |
| `credit_authorization` | borrower | yes |
| `human_review` | loan team | **never** |

A document only the loan team can obtain — the credit report above all — is the team's task. A
borrower shown "credit_report · REPLACE" is being asked to obtain something a consumer cannot
obtain, with a raw key for a name.

---

## 5. The one number

`operational.percent` is the share of required information and documents that is present and
free of open questions. It is arithmetic over a checklist and nothing more.

It travels with `meaning` and `notMeaning` as data, so no screen can render the number without
rendering what it is not: not an approval, not a probability of approval, not a credit decision,
not an underwriting opinion. A file at 100% can still be denied; a file at 40% can close.

Human-review items are deliberately **excluded from the denominator**. A processor's reading of
a flagged deposit is not something the file is missing, and counting it would mean no file could
ever be operationally complete while somebody still had an opinion to form.

There is exactly one such number in the product. The pre-underwriting panel used to carry a
second, differently weighted one; two numbers next to one borrower's name is how a processor and
a borrower end up describing the same file differently on a phone call.

---

## 6. What the document layer checks

Deterministic, in `completeness.js`, from the catalog. The model's only job is to say what a
document **is** and what it **says**; whether that is enough is decided by rules.

Per type: pages, sides, expiration, policy period, freshness, month count, month contiguity,
day coverage, tax years, tax package completeness, tri-merge, signatures.

Universal — properties of "a document somebody sent us" rather than of any one type:

- **`illegible`** — the reader could not make it out. Asked for again, because a document nobody
  can read has satisfied nothing. The ask names **no cause**: we do not know whether it was the
  camera, the paper or the light, and saying would be inventing.
- **`duplicate`** — the same document twice. **Informational**, never outstanding. People
  re-send when they are not sure the first one arrived, and treating it as a defect would leave
  the file permanently short of an item nothing could ever close.
- **`ownership_unclear`** — a document in a name that shares *nothing* with the borrower's.
  Deliberately hard to trigger: one shared token and we say nothing. A maiden name, a middle
  name, a nickname and a joint account all look like a mismatch to a string comparison, and
  telling someone their own bank statement is not theirs is worse than not asking. It carries
  `needsConfirmation` and is phrased as a question, because it is uncertainty and must never be
  recorded as fact.

Uncertainty is never converted into fact anywhere in this layer. A value that was not read is
`null`, not `0` — `Number('')` and `Number(null)` both being `0` has been a live bug in this
codebase three separate times.

`completeness.js` reports everything it sees, including gaps derived from shaky reads. Deciding
who may be TOLD is `fileTasks.js`'s job, not this layer's — see "Why it only speaks when it is
sure" above. Keeping the two apart means a processor still gets the full picture.

---

## 7. The ARIVE handoff

`portal-arive-handoff` produces a worksheet, not an integration.

- `transfer.occurred` is `false` and arrives from the server **as data**, so no component can
  decide to leave the disclaimer off.
- A field nobody answered is a row with `missing: true`, shown by default. A blank box you
  cannot see is a blank box that gets skipped.
- A secure field (SSN, account numbers) is never carried. It appears as a row saying to collect
  it directly in ARIVE, because the person keying has to enter something and needs to know this
  product deliberately does not hold it.
- A contradiction is surfaced, never resolved. Picking one answer would put a wrong number into
  the system of record with a confident-looking provenance.
- Nothing is computed: no DTI, no LTV, no qualifying income. A conclusion typed into ARIVE by a
  person reading this sheet would be this product making an underwriting judgement through a
  human's hands.

`documentPackage.js` organizes the uploads and derives a filed-as name from what was read.
**Nothing is renamed in storage.** The stored object keeps the name the borrower's device gave
it, forever — a mortgage file is an evidentiary record, and a year from now somebody has to be
able to prove which file was which. The mapping carries the facts that produced each name, so it
is reversible by someone who was not here. A filename ends up in email subjects, shared folders
and screenshots; it is the least controlled surface in the product, and nothing off the document
— no score, no account number — may reach one.

---

## 8. Operational notes

| thing | where |
|---|---|
| queue table | `document_read_jobs` (delta 009) — server-only, RLS on, no anon/authenticated grants |
| worker | `netlify/functions/pre-underwriting-read-worker.mjs`, `schedule: '* * * * *'` |
| retry bound | 3 attempts, then `failed` with `last_error_code` for a person to see |
| abandoned claims | reclaimed after `CLAIM_TTL_MS` (10 min) |
| one live job per document | partial unique index — a double tap cannot read (and bill for) the same PDF twice |
| worker reachability | Netlify scheduled functions have no public URL. `OURMTG_READ_WORKER_KEY` guards the non-scheduled path and fails closed when unset |
| settled vs retryable | a refusal, an unreadable format or an infected file stops; a timeout or provider error goes back on the queue |
| claim fencing | `finish()` guards on `claimed_at`, not on status. When a stalled worker's job has been reclaimed the row IS `running` — B is running it — so status alone cannot tell the two apart. The claim timestamp is set afresh on every claim and is the fencing token |
| rollback | `supabase/delta/009_document_read_queue_rollback.sql`. Stop the worker first (`PRE_UNDERWRITING_ENABLED=false` is fastest), then drop. Rehearsed against a queue with work in flight, twice, and rolled forward again |

### The audit trail

Nobody is watching this run, so the record it leaves is the only account of what it did. Every
row is written with `portal_user = null`: no person did it, and that null IS the record that it
was the system.

| action | target | when |
|---|---|---|
| `pre_underwriting_intake_auto` | `<documentId>:read` | a read succeeded |
| `pre_underwriting_intake_auto` | `<documentId>:<code>` | a read failed, refused, or threw |
| `pre_underwriting_intake_auto` | `<documentId>:document_gone` | the document had been removed before the worker reached it |
| `borrower_followup_sent` | `<documentId>:sent:<outstanding>` | a message was written |
| `borrower_followup_suppressed` | `<documentId>:<reason>` | a message was deliberately not written |

Suppression reasons: `unchanged` (the borrower already has this ask), `nothing_to_say`,
`read_will_retry`, `claim_lost`, `insert_failed`, `error`. A decision to stay silent is exactly
as much a decision as a decision to write, and it is the half that is impossible to reconstruct
afterwards if it is not recorded. Targets are ids and fixed codes only — no document content and
no borrower text ever enters the audit log.

### Feature flags

Server flags authorize; `VITE_FF_*` only mounts routes and authorizes nothing.

- `PRE_UNDERWRITING_ENABLED` — the read worker, the intake endpoint, the panel endpoints.
- `CONVERSATIONAL_1003_ENABLED` — the interview.
- `VITE_FF_PRE_UNDERWRITING`, `VITE_FF_CONVERSATIONAL_1003` — presentation only.

---

## 9. Fixtures

`src/features/pre-underwriting/fixtures/documentScenarios.js` holds the named situations the
document layer must handle, each running through the real path: raw model response →
`validateExtractionResponse` → `toPart` → `assessCompleteness` → `buildFileTasks` →
`composeFollowUp`.

All fixture data is **invented**. No real person, institution, account or identifier appears in
it, and none may ever be added — a redaction that misses one line is a data breach committed by
a test fixture. The suite asserts this directly.
